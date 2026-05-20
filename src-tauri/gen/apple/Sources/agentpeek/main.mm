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

            // Poll for cameraView removal. As long as the cameraView is alive AND has a
            // superview, keep the button. Once it's gone or detached, remove the button.
            __block void (^tick)(void) = nil;
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

int main(int argc, char * argv[]) {
	[WKWebView class]; // force-load WebKit framework
	agentpeek_install_scan_close_swizzle();
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_install_kb_swizzle(); });
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_install_scanner_cancel_swizzle(); });
	ffi::start_app();
	return 0;
}
