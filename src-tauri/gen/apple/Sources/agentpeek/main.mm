#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static int _agentpeek_swizzle_attempts = 0;
static int _agentpeek_cancel_swizzle_attempts = 0;

// Find the barcode-scanner Swift class. Its runtime name is mangled with the module
// prefix (e.g. "tauri_plugin_barcode_scanner.BarcodeScannerPlugin"), so iterate the
// runtime class list to locate it by suffix.
static Class agentpeek_find_class_by_suffix(const char *suffix) {
    int count = objc_getClassList(NULL, 0);
    if (count <= 0) return NULL;
    Class *classes = (Class *)malloc(sizeof(Class) * count);
    objc_getClassList(classes, count);
    Class found = NULL;
    for (int i = 0; i < count; i++) {
        const char *name = class_getName(classes[i]);
        if (name && strstr(name, suffix)) { found = classes[i]; break; }
    }
    free(classes);
    return found;
}

// Plugin's cancel(_:) is called from a background dispatch queue (Tauri IPC) but
// internally calls UIView.removeFromSuperview, which requires the main thread.
// On iOS 17+, UIKit asserts on this and crashes (NSAssertion / SIGABRT).
// Fix by swizzling cancel(_:) to dispatch to main thread first.
static void agentpeek_install_scanner_cancel_swizzle(void) {
    Class plugin = agentpeek_find_class_by_suffix("BarcodeScannerPlugin");
    if (!plugin) {
        if (_agentpeek_cancel_swizzle_attempts++ < 30) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ agentpeek_install_scanner_cancel_swizzle(); });
        }
        return;
    }
    SEL sel = @selector(cancel:);
    Method m = class_getInstanceMethod(plugin, sel);
    if (!m) return;
    IMP origImp = method_getImplementation(m);
    IMP newImp = imp_implementationWithBlock(^(id self_, id invoke) {
        if ([NSThread isMainThread]) {
            ((void (*)(id, SEL, id))origImp)(self_, sel, invoke);
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                ((void (*)(id, SEL, id))origImp)(self_, sel, invoke);
            });
        }
    });
    method_setImplementation(m, newImp);
}

// Inject a native close (×) button when the barcode scanner shows its CameraView.
// We attach the button to the keyWindow (full-screen frame, immune to whatever frame
// CameraView's superview has) and pin it to the window's safeAreaLayoutGuide so it
// reliably appears at the top-right under the Dynamic Island / notch. We then poll
// every 200ms; once the CameraView is gone (scan finished or cancelled), we remove
// the button. Tapping the button evaluates window.__cancelScan() in the webview.
static void agentpeek_install_scan_close_swizzle(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        SEL sel = @selector(didAddSubview:);
        Method orig = class_getInstanceMethod([UIView class], sel);
        IMP origImp = method_getImplementation(orig);
        IMP newImp = imp_implementationWithBlock(^(UIView *self, UIView *subview) {
            ((void (*)(id, SEL, UIView *))origImp)(self, sel, subview);

            const char *clsName = object_getClassName(subview);
            if (!clsName || strstr(clsName, "CameraView") == NULL) return;

            // Find webview anywhere in the scene to evaluate JS on.
            __block WKWebView *webView = nil;
            for (UIView *sib in self.subviews) {
                if ([sib isKindOfClass:[WKWebView class]]) { webView = (WKWebView *)sib; break; }
            }
            if (!webView) {
                UIView *parent = self.superview;
                while (parent && !webView) {
                    for (UIView *sib in parent.subviews) {
                        if ([sib isKindOfClass:[WKWebView class]]) { webView = (WKWebView *)sib; break; }
                    }
                    parent = parent.superview;
                }
            }
            if (!webView) return;

            // Find the key window (button host).
            __block UIWindow *kw = nil;
            for (UIScene *s in [UIApplication sharedApplication].connectedScenes) {
                if ([s isKindOfClass:[UIWindowScene class]]) {
                    for (UIWindow *w in ((UIWindowScene *)s).windows) {
                        if (w.isKeyWindow) { kw = w; break; }
                    }
                }
                if (kw) break;
            }
            if (!kw) return;

            // Remove any leftover button from previous scan.
            for (UIView *v in [kw.subviews copy]) {
                if (v.tag == 0xC10E) [v removeFromSuperview];
            }

            UIButton *btn = [UIButton buttonWithType:UIButtonTypeSystem];
            btn.tag = 0xC10E;
            btn.translatesAutoresizingMaskIntoConstraints = NO;
            btn.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
            btn.tintColor = [UIColor whiteColor];
            // SF Symbol "xmark" is centered by design — avoids the baseline offset
            // that the "×" Unicode glyph (U+00D7) has inside a UIButton.
            UIImageSymbolConfiguration *cfg = [UIImageSymbolConfiguration
                configurationWithPointSize:14 weight:UIImageSymbolWeightSemibold];
            UIImage *icon = [UIImage systemImageNamed:@"xmark" withConfiguration:cfg];
            [btn setImage:icon forState:UIControlStateNormal];
            btn.layer.cornerRadius = 22;

            __weak WKWebView *weakWeb = webView;
            __weak UIView *weakCam = subview;
            __weak UIButton *weakBtn = btn;
            [btn addAction:[UIAction actionWithTitle:@"" image:nil identifier:nil
                                             handler:^(UIAction *action) {
                [weakWeb evaluateJavaScript:@"window.__cancelScan && window.__cancelScan()" completionHandler:nil];
            }] forControlEvents:UIControlEventTouchUpInside];

            [kw addSubview:btn];
            [kw bringSubviewToFront:btn];

            UILayoutGuide *safe = kw.safeAreaLayoutGuide;
            [NSLayoutConstraint activateConstraints:@[
                [btn.topAnchor constraintEqualToAnchor:safe.topAnchor constant:8],
                [btn.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
                [btn.widthAnchor constraintEqualToConstant:44],
                [btn.heightAnchor constraintEqualToConstant:44],
            ]];

            // Poll for cameraView removal — remove button when camera is gone.
            // Intentional retain cycle: tick holds itself via __block; broken by tick=nil on exit.
            __block void (^tick)(void) = nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-retain-cycles"
            tick = ^{
                UIView *cam = weakCam;
                UIButton *b = weakBtn;
                if (!b || b.window == nil) { tick = nil; return; }
                if (!cam || cam.superview == nil) {
                    [b removeFromSuperview];
                    tick = nil;
                    return;
                }
                [b.superview bringSubviewToFront:b];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)),
                               dispatch_get_main_queue(), tick);
            };
#pragma clang diagnostic pop
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), tick);
        });
        method_setImplementation(orig, newImp);
    });
}

// Disable iOS keyboard accessory toolbar (the prev/next/done bar above keyboard).
// WKContentView is a private class, so retry until WebKit registers it.
static void agentpeek_install_kb_swizzle(void) {
    _agentpeek_swizzle_attempts++;
    Class WKContentView = NSClassFromString(@"WKContentView");
    if (!WKContentView) {
        if (_agentpeek_swizzle_attempts < 30) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ agentpeek_install_kb_swizzle(); });
        }
        return;
    }

    IMP assistantImp = imp_implementationWithBlock(^UITextInputAssistantItem *(id _self) {
        UITextInputAssistantItem *item = [[UITextInputAssistantItem alloc] init];
        item.leadingBarButtonGroups = @[];
        item.trailingBarButtonGroups = @[];
        return item;
    });
    SEL assistantSel = @selector(inputAssistantItem);
    Method assistantM = class_getInstanceMethod(WKContentView, assistantSel);
    if (assistantM) {
        method_setImplementation(assistantM, assistantImp);
    } else {
        class_addMethod(WKContentView, assistantSel, assistantImp, "@@:");
    }

    IMP accessoryImp = imp_implementationWithBlock(^UIView *(id _self) { return nil; });
    SEL accessorySel = @selector(inputAccessoryView);
    Method accessoryM = class_getInstanceMethod(WKContentView, accessorySel);
    if (accessoryM) {
        method_setImplementation(accessoryM, accessoryImp);
    } else {
        class_addMethod(WKContentView, accessorySel, accessoryImp, "@@:");
    }
}

// WebKit bug (Bug 306465, 254868): viewport-fit=cover doesn't extend CSS viewport
// past safe area on some iOS versions. Workaround: negate safeAreaInsets via
// additionalSafeAreaInsets so WebKit calculates viewport = full screen. Then inject
// real inset values as CSS custom properties (--sat/--sab) since env() becomes 0.
// Only applies when WKContentView height < window height (bug is present).
static void agentpeek_fix_viewport(void) {

    UIWindow *kw = nil;
    for (UIScene *s in [UIApplication sharedApplication].connectedScenes) {
        if ([s isKindOfClass:[UIWindowScene class]]) {
            for (UIWindow *w in ((UIWindowScene *)s).windows) {
                if (w.isKeyWindow) { kw = w; break; }
            }
        }
        if (kw) break;
    }
    if (!kw || !kw.rootViewController) {
        static int retries = 0;
        if (retries++ < 60) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ agentpeek_fix_viewport(); });
        }
        return;
    }

    UIEdgeInsets sa = kw.safeAreaInsets;
    if (sa.top <= 0 && sa.bottom <= 0) return;

    // Check if bug is present: find WKWebView scrollView contentSize < window height.
    WKWebView *checkWv = nil;
    for (UIView *sub in kw.rootViewController.view.subviews) {
        if ([sub isKindOfClass:[WKWebView class]]) { checkWv = (WKWebView *)sub; break; }
    }
    if (!checkWv) {
        static int retries2 = 0;
        if (retries2++ < 60) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ agentpeek_fix_viewport(); });
        }
        return;
    }
    // Keep the WKWebView root fixed; scrolling belongs to CSS overflow containers.
    checkWv.allowsBackForwardNavigationGestures = NO;
    checkWv.scrollView.scrollEnabled = NO;
    checkWv.scrollView.bounces = NO;
    checkWv.scrollView.alwaysBounceVertical = NO;

    CGFloat contentH = checkWv.scrollView.contentSize.height;
    CGFloat windowH = kw.bounds.size.height;
    // If contentSize already matches window (viewport-fit=cover works), skip fix.
    if (contentH >= windowH - 1) return;

    // Negate safe area so WebKit viewport covers full screen.
    kw.rootViewController.additionalSafeAreaInsets =
        UIEdgeInsetsMake(-sa.top, -sa.left, -sa.bottom, -sa.right);

    // Inject real safe area values as CSS custom properties.
    // Use WKUserScript for reliable early injection on every page load.
    WKWebView *wv = nil;
    for (UIView *sub in kw.rootViewController.view.subviews) {
        if ([sub isKindOfClass:[WKWebView class]]) { wv = (WKWebView *)sub; break; }
    }
    if (wv) {
        NSString *js = [NSString stringWithFormat:
            @"(function(){"
             "var s=document.documentElement.style;"
             "s.setProperty('--sat','%.0fpx');"
             "s.setProperty('--sab','%.0fpx');"
             "s.setProperty('--sal','%.0fpx');"
             "s.setProperty('--sar','%.0fpx');"
             "})()",
            sa.top, sa.bottom, sa.left, sa.right];
        WKUserScript *script = [[WKUserScript alloc]
            initWithSource:js
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
            forMainFrameOnly:YES];
        [wv.configuration.userContentController addUserScript:script];
        // Also evaluate immediately for the current page.
        [wv evaluateJavaScript:js completionHandler:nil];
    }
}

// Native skeleton overlay: instantiate the LaunchScreen view over the key window to cover the ~400ms gap between LaunchScreen removal and the web skeleton paint (else the bare WKWebView bg flashes); poll window.__skelReady, then fade out. See docs/headless-streaming.md or CLAUDE.md.
static void agentpeek_find_webview(UIWindow *kw, void (^cb)(WKWebView *)) {
    WKWebView *wv = nil;
    if (kw.rootViewController) {
        for (UIView *sub in kw.rootViewController.view.subviews) {
            if ([sub isKindOfClass:[WKWebView class]]) { wv = (WKWebView *)sub; break; }
        }
    }
    cb(wv);
}

static void agentpeek_install_skeleton_overlay(void) {
    UIWindow *kw = nil;
    for (UIScene *s in [UIApplication sharedApplication].connectedScenes) {
        if ([s isKindOfClass:[UIWindowScene class]]) {
            for (UIWindow *w in ((UIWindowScene *)s).windows) {
                if (w.isKeyWindow) { kw = w; break; }
            }
        }
        if (kw) break;
    }
    if (!kw || !kw.rootViewController) {
        static int retries = 0;
        if (retries++ < 100) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.02 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ agentpeek_install_skeleton_overlay(); });
        }
        return;
    }

    // Instantiate the LaunchScreen storyboard's root view — identical skeleton.
    UIView *skel = nil;
    @try {
        UIStoryboard *sb = [UIStoryboard storyboardWithName:@"LaunchScreen" bundle:nil];
        UIViewController *vc = [sb instantiateInitialViewController];
        if (vc && vc.view) {
            skel = vc.view;
            skel.frame = kw.bounds;
            skel.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        }
    } @catch (__unused NSException *e) {}
    if (!skel) return;

    skel.tag = 0x5EE1;
    [kw addSubview:skel];
    [kw bringSubviewToFront:skel];
    // Card borders use nested views (outer=#30363d, inner inset 1px) in the storyboard, so they render in the system LaunchScreen phase — no code needed.

    // Poll window.__skelReady; fade out on paint. Hard cap so the overlay can't stick if the web layer never signals.
    __weak UIView *weakSkel = skel;
    __weak UIWindow *weakKw = kw;
    __block int ticks = 0;
    __block void (^poll)(void) = nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-retain-cycles"
    poll = ^{
        UIView *sv = weakSkel;
        if (!sv || sv.superview == nil) { poll = nil; return; }
        ticks++;
        BOOL timedOut = ticks > 250; // ~5s hard cap (20ms * 250)
        agentpeek_find_webview(weakKw, ^(WKWebView *wv) {
            // 150ms fade out — soft handoff to the web layer (skeleton or SWR-cached content underneath).
            void (^fadeOut)(void) = ^{
                [UIView animateWithDuration:0.15 animations:^{ sv.alpha = 0.0; }
                                 completion:^(__unused BOOL done){ [sv removeFromSuperview]; }];
                poll = nil;
            };
            if (timedOut || !wv) { fadeOut(); return; }
            [wv evaluateJavaScript:@"window.__skelReady?1:0" completionHandler:^(id result, __unused NSError *err) {
                if ([result respondsToSelector:@selector(intValue)] && [result intValue] == 1) {
                    fadeOut();
                } else {
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.02 * NSEC_PER_SEC)),
                                   dispatch_get_main_queue(), ^{ if (poll) poll(); });
                }
            }];
        });
    };
#pragma clang diagnostic pop
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.02 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), poll);
}

int main(int argc, char * argv[]) {
	[WKWebView class]; // force-load WebKit framework
	agentpeek_install_scan_close_swizzle();
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_install_skeleton_overlay(); });
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_install_kb_swizzle(); });
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_install_scanner_cancel_swizzle(); });
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_fix_viewport(); });
	ffi::start_app();
	return 0;
}
