#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static int _agentpeek_swizzle_attempts = 0;

// Brand background #0d1117 — applied to WKWebView so the first frame matches the
// LaunchScreen / native window, eliminating the white flash before HTML CSS loads.
static UIColor *agentpeek_brand_bg(void) {
    return [UIColor colorWithRed:13.0/255.0 green:17.0/255.0 blue:23.0/255.0 alpha:1.0];
}

// Swizzle WKWebView's designated initializer so every webview is born with a
// dark background — the very first frame painted to screen is #0d1117 instead
// of the WKWebView default white surface.
static void agentpeek_install_webview_bg_swizzle(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class cls = [WKWebView class];

        // 1. -initWithFrame:configuration: (designated initializer)
        SEL initSel = @selector(initWithFrame:configuration:);
        Method initOrig = class_getInstanceMethod(cls, initSel);
        IMP initOrigImp = method_getImplementation(initOrig);
        IMP initNewImp = imp_implementationWithBlock(^id(WKWebView *self, CGRect frame, WKWebViewConfiguration *config) {
            id result = ((id (*)(id, SEL, CGRect, WKWebViewConfiguration *))initOrigImp)(self, initSel, frame, config);
            if (result) {
                ((WKWebView *)result).opaque = NO;
                ((WKWebView *)result).backgroundColor = agentpeek_brand_bg();
                ((WKWebView *)result).scrollView.backgroundColor = agentpeek_brand_bg();
            }
            return result;
        });
        method_setImplementation(initOrig, initNewImp);

        // 2. Belt-and-suspenders: also swizzle -didMoveToWindow so any webview
        //    that bypasses the init swizzle (e.g. via decoder) still gets the bg.
        SEL movSel = @selector(didMoveToWindow);
        Method movOrig = class_getInstanceMethod(cls, movSel);
        IMP movOrigImp = method_getImplementation(movOrig);
        IMP movNewImp = imp_implementationWithBlock(^(WKWebView *self) {
            ((void (*)(id, SEL))movOrigImp)(self, movSel);
            self.opaque = NO;
            self.backgroundColor = agentpeek_brand_bg();
            self.scrollView.backgroundColor = agentpeek_brand_bg();
        });
        method_setImplementation(movOrig, movNewImp);
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
	agentpeek_install_webview_bg_swizzle(); // dark webview background — must run before any WKWebView is created
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_install_kb_swizzle(); });
	ffi::start_app();
	return 0;
}
