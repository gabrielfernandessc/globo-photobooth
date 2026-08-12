plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.globo.photobooth"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.globo.photobooth"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "2.3"

        // O servidor padrão. O app abre direto nele, sem perguntar nada;
        // trocar só é preciso quando o evento roda com servidor local.
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://globo-photobooth.vercel.app\"")
    }

    /*
     * Assinatura estável.
     *
     * O Android recusa atualizar um app assinado com chave diferente da
     * instalada — dá "o pacote tem conflito com um pacote existente". A
     * chave de debug do Gradle é gerada na máquina de build, então cada
     * execução do CI produzia um APK com assinatura nova e a atualização
     * era impossível.
     *
     * A chave vem do ambiente (Secrets do GitHub) e nunca entra no
     * repositório. Sem ela — build local, por exemplo — o Gradle cai na
     * chave de debug de sempre.
     */
    val keystoreB64: String? = System.getenv("ANDROID_KEYSTORE_B64")
    val keystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")
    val keystoreFile = rootProject.file("release.p12")

    if (!keystoreB64.isNullOrBlank() && !keystorePassword.isNullOrBlank()) {
        keystoreFile.writeBytes(java.util.Base64.getDecoder().decode(keystoreB64.trim()))
    }

    signingConfigs {
        create("stable") {
            if (keystoreFile.exists() && !keystorePassword.isNullOrBlank()) {
                storeFile = keystoreFile
                storePassword = keystorePassword
                keyAlias = "fotoboarding"
                keyPassword = keystorePassword
                storeType = "PKCS12"
            }
        }
    }

    buildTypes {
        debug {
            // O APK de debug é o que sai do CI para sideload interno.
            isMinifyEnabled = false
            if (keystoreFile.exists() && !keystorePassword.isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("stable")
            }
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    val camerax = "1.4.2"

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    // viewModelScope
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    // LocalLifecycleOwner: o de compose-ui está deprecado
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")

    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // CameraX: preview, análise (frames do relay) e captura em resolução plena
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")

    implementation("io.socket:socket.io-client:2.1.1") {
        exclude(group = "org.json", module = "json")
    }
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
