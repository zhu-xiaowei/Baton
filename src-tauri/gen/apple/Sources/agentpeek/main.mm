#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static int _agentpeek_swizzle_attempts = 0;

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
	dispatch_async(dispatch_get_main_queue(), ^{ agentpeek_install_kb_swizzle(); });
	ffi::start_app();
	return 0;
}
