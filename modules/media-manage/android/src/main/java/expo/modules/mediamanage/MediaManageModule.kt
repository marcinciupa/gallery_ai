package expo.modules.mediamanage

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * „Aplikacje do zarządzania multimediami" (`MANAGE_MEDIA`, Android 12+). JS nie ma do tego API:
 * stan to appop, a nie runtime-permission (PermissionsAndroid.check zawsze mówi „nie"), a ekran
 * ustawień wymaga danych `package:` w intencie, których `Linking.sendIntent` nie przekazuje.
 */
class MediaManageModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MediaManage")

    /** Czy system w ogóle zna to uprawnienie (Android 12+). Na 11 okna zgody zostają i nie ma o co pytać. */
    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.S }

    /** Stan przełącznika. Czytany na żywo — zmiana w ustawieniach działa bez restartu apki. */
    Function("canManageMedia") {
      val ctx = appContext.reactContext ?: return@Function false
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && MediaStore.canManageMedia(ctx)
    }

    /** Otwiera systemowy ekran z przełącznikiem dla NASZEJ apki. Zwraca false, gdy nie dało się go otworzyć. */
    Function("openSettings") {
      val ctx = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
      val intent = Intent(Settings.ACTION_REQUEST_MANAGE_MEDIA, Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        (appContext.currentActivity ?: ctx).startActivity(intent)
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
