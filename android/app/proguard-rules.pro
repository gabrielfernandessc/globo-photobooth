# Socket.IO e OkHttp usam reflexão/classes opcionais; sem estas regras o
# build de release quebra em runtime, não na compilação.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-keep class io.socket.** { *; }
-keep class org.json.** { *; }
