#![cfg(any(target_os = "android", target_os = "ios"))]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_push);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("push")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            api.register_ios_plugin(init_plugin_push)?;
            #[cfg(target_os = "android")]
            api.register_android_plugin("com.batonai.push", "PushPlugin")?;
            Ok(())
        })
        .build()
}
