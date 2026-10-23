plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
android {
  namespace = "com.batonai.download"
  compileSdk = 36
  defaultConfig { minSdk = 24 }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
  kotlinOptions { jvmTarget = "1.8" }
  sourceSets["test"].java.setSrcDirs(listOf(file("../../../../test/native/local-image/android"), file("../../../../test/native/download-queue")))
}
dependencies {
  implementation(project(":tauri-android"))
  testImplementation("junit:junit:4.13.2")
}
