import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Version fallback when tauri.properties has not been generated yet: read src-tauri/tauri.conf.json
// and derive versionCode the way the Tauri CLI does (major * 1_000_000 + minor * 1_000 + patch), so
// every build of the same version shares one monotonically increasing code.
val tauriConfigVersion: String? = file("../../../tauri.conf.json").takeIf { it.exists() }?.let { config ->
    Regex("\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+)[^\"]*\"").find(config.readText())?.groupValues?.get(1)
}
val fallbackVersionCode: Int = tauriConfigVersion?.split('.')?.map { it.toInt() }
    ?.let { (major, minor, patch) -> major * 1_000_000 + minor * 1_000 + patch } ?: 1

// Release signing (MOB-08). Values come from the environment first, then from an untracked
// keystore.properties next to this module's parent (src-tauri/gen/android/keystore.properties):
//   storeFile=/absolute/path/openplod-release.jks
//   storePassword=...
//   keyAlias=openplod
//   keyPassword=...
// Neither the keystore nor the properties file is ever committed (see .gitignore). Keep the same
// key and applicationId for every release, or Android refuses the in-place upgrade.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
fun signingValue(property: String, environment: String): String? =
    System.getenv(environment)?.takeIf { it.isNotBlank() } ?: keystoreProperties.getProperty(property)?.takeIf { it.isNotBlank() }
val releaseStoreFile = signingValue("storeFile", "OPENPLOD_ANDROID_KEYSTORE")
val releaseSigningConfigured = releaseStoreFile != null &&
    signingValue("storePassword", "OPENPLOD_ANDROID_KEYSTORE_PASSWORD") != null &&
    signingValue("keyAlias", "OPENPLOD_ANDROID_KEY_ALIAS") != null &&
    signingValue("keyPassword", "OPENPLOD_ANDROID_KEY_PASSWORD") != null

android {
    compileSdk = 36
    namespace = "com.openplod.vault"
    defaultConfig {
        // The mobile app connects directly to the paired desktop on the private LAN.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.openplod.vault"
        minSdk = 24
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        versionCode = tauriProperties.getProperty("tauri.android.versionCode")?.toInt() ?: fallbackVersionCode
        versionName = tauriProperties.getProperty("tauri.android.versionName") ?: tauriConfigVersion ?: "1.0"
    }
    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = signingValue("storePassword", "OPENPLOD_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "OPENPLOD_ANDROID_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "OPENPLOD_ANDROID_KEY_PASSWORD")
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Without signing values the release build stays unsigned (and is not installable),
            // which is safer than silently signing a release with the debug key.
            if (releaseSigningConfigured) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        resources.excludes.add("META-INF/versions/9/OSGI-INF/MANIFEST.MF")
        // Device audio stays Ogg Opus. The SDK's unused MP3 encoder only supports 4 KB pages.
        jniLibs.excludes.add("**/liblame.so")
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.9.3")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
