package uz.defactum.nurse;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import android.content.SharedPreferences;

import com.getcapacitor.plugin.WebView;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;

/**
 * Печать этикеток на портативный Bluetooth-принтер (классический Bluetooth, профиль SPP)
 * и передача этикеток картинками в другое приложение (например, в программу принтера).
 * Принтер сначала сопрягается в настройках Bluetooth телефона, здесь выбирается из сопряжённых.
 */
@CapacitorPlugin(
    name = "LabelPrinter",
    permissions = { @Permission(alias = "bt", strings = { Manifest.permission.BLUETOOTH_CONNECT }) }
)
public class LabelPrinterPlugin extends Plugin {

    /** Уровень «родной» части. Если в новой версии он выше — нужен новый APK, иначе хватает обновления веб-части. */
    private static final int NATIVE_LEVEL = 2;

    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    /** До Android 12 отдельного разрешения не нужно; с Android 12 — «Устройства поблизости». */
    private boolean allowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getPermissionState("bt") == PermissionState.GRANTED;
    }

    private boolean askFirst(PluginCall call, String callback) {
        if (allowed()) return false;
        requestPermissionForAlias("bt", call, callback);
        return true;
    }

    @PluginMethod
    public void list(PluginCall call) {
        if (askFirst(call, "listAfterPermission")) return;
        doList(call);
    }

    @PermissionCallback
    private void listAfterPermission(PluginCall call) {
        if (allowed()) doList(call); else call.reject("Нет разрешения на Bluetooth (Устройства поблизости)");
    }

    private void doList(PluginCall call) {
        try {
            BluetoothAdapter a = adapter();
            JSObject res = new JSObject();
            JSArray arr = new JSArray();
            res.put("supported", a != null);
            res.put("enabled", a != null && a.isEnabled());
            if (a != null && a.isEnabled()) {
                for (BluetoothDevice d : a.getBondedDevices()) {
                    JSObject o = new JSObject();
                    o.put("name", d.getName() == null ? d.getAddress() : d.getName());
                    o.put("address", d.getAddress());
                    arr.put(o);
                }
            }
            res.put("devices", arr);
            call.resolve(res);
        } catch (SecurityException e) {
            call.reject("Нет разрешения на Bluetooth");
        } catch (Exception e) {
            call.reject("Bluetooth: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось открыть настройки Bluetooth");
        }
    }

    @PluginMethod
    public void print(PluginCall call) {
        if (askFirst(call, "printAfterPermission")) return;
        doPrint(call);
    }

    @PermissionCallback
    private void printAfterPermission(PluginCall call) {
        if (allowed()) doPrint(call); else call.reject("Нет разрешения на Bluetooth (Устройства поблизости)");
    }

    private void doPrint(final PluginCall call) {
        final String address = call.getString("address");
        final String b64 = call.getString("data");
        if (address == null || b64 == null) { call.reject("Не выбран принтер"); return; }
        new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothAdapter a = adapter();
                if (a == null || !a.isEnabled()) { call.reject("Включите Bluetooth"); return; }
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                BluetoothDevice d = a.getRemoteDevice(address);
                try { a.cancelDiscovery(); } catch (Exception ignored) { }
                try {
                    socket = d.createRfcommSocketToServiceRecord(SPP);
                    socket.connect();
                } catch (IOException first) {
                    try { if (socket != null) socket.close(); } catch (IOException ignored) { }
                    socket = d.createInsecureRfcommSocketToServiceRecord(SPP);
                    socket.connect();
                }
                OutputStream out = socket.getOutputStream();
                final int chunk = 512;
                for (int i = 0; i < data.length; i += chunk) {
                    out.write(data, i, Math.min(chunk, data.length - i));
                    out.flush();
                    Thread.sleep(12);
                }
                // даём принтеру допечатать, прежде чем закрыть соединение
                Thread.sleep(Math.min(6000, 800 + data.length / 20));
                JSObject res = new JSObject();
                res.put("bytes", data.length);
                call.resolve(res);
            } catch (SecurityException e) {
                call.reject("Нет разрешения на Bluetooth");
            } catch (IOException e) {
                call.reject("Принтер не отвечает: включите его и проверьте, что он сопряжён с телефоном");
            } catch (Exception e) {
                call.reject("Ошибка печати: " + e.getMessage());
            } finally {
                try { if (socket != null) socket.close(); } catch (IOException ignored) { }
            }
        }).start();
    }

    /** Отдаёт картинки этикеток в другое приложение через стандартное окно «Поделиться». */
    @PluginMethod
    public void share(PluginCall call) {
        try {
            JSArray files = call.getArray("files");
            if (files == null || files.length() == 0) { call.reject("Нет этикеток"); return; }
            File dir = new File(getContext().getCacheDir(), "labels");
            if (!dir.exists() && !dir.mkdirs()) { call.reject("Не удалось создать папку"); return; }
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            ArrayList<Uri> uris = new ArrayList<>();
            for (int i = 0; i < files.length(); i++) {
                JSObject o = JSObject.fromJSONObject(files.getJSONObject(i));
                String name = o.getString("name", "label" + (i + 1) + ".png").replaceAll("[^A-Za-z0-9._-]", "_");
                File f = new File(dir, name);
                try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(Base64.decode(o.getString("data"), Base64.DEFAULT)); }
                uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f));
            }
            Intent i = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
            i.setType("image/png");
            if (uris.size() == 1) i.putExtra(Intent.EXTRA_STREAM, uris.get(0)); else i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(i, call.getString("title", "Этикетки"));
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось передать этикетки: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- Обновление приложения

    @PluginMethod
    public void info(PluginCall call) {
        JSObject res = new JSObject();
        res.put("native", NATIVE_LEVEL);
        try {
            res.put("apkVersion", getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (Exception ignored) { }
        call.resolve(res);
    }

    private void progress(String phase, int percent) {
        JSObject o = new JSObject();
        o.put("phase", phase);
        o.put("percent", percent);
        notifyListeners("progress", o);
    }

    /** Скачивает файл с показом процентов. */
    private void download(String address, File target) throws IOException {
        HttpURLConnection c = null;
        try {
            URL url = new URL(address);
            for (int hop = 0; hop < 6; hop++) { // GitHub отдаёт файл через переадресацию на другой сервер
                c = (HttpURLConnection) url.openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", "defactum-nurse");
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                    url = new URL(url, c.getHeaderField("Location"));
                    c.disconnect();
                    continue;
                }
                if (code != 200) throw new IOException("Сервер ответил " + code);
                break;
            }
            long total = c.getContentLength(), done = 0;
            int last = -1;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = new BufferedInputStream(c.getInputStream()); FileOutputStream out = new FileOutputStream(target)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : -1;
                    if (pct != last) { last = pct; progress("download", pct); }
                }
            }
            if (total > 0 && done != total) throw new IOException("Файл скачан не полностью");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    /** Обновление веб-части: скачать архив, распаковать во внутреннюю память и переключить приложение на новую папку. */
    @PluginMethod
    public void updateWeb(final PluginCall call) {
        final String url = call.getString("url");
        final String version = call.getString("version", "new").replaceAll("[^0-9A-Za-z._-]", "_");
        if (url == null) { call.reject("Нет адреса обновления"); return; }
        new Thread(() -> {
            File zip = new File(getContext().getCacheDir(), "update-web.zip");
            File root = new File(getContext().getFilesDir(), "web");
            File dir = new File(root, version + "-" + System.currentTimeMillis());
            try {
                download(url, zip);
                progress("unpack", 0);
                if (!dir.mkdirs()) throw new IOException("Не удалось создать папку обновления");
                String base = dir.getCanonicalPath() + File.separator;
                long size = zip.length(), read = 0;
                int last = -1;
                byte[] buf = new byte[64 * 1024];
                try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new java.io.FileInputStream(zip)))) {
                    ZipEntry e;
                    while ((e = zin.getNextEntry()) != null) {
                        File out = new File(dir, e.getName());
                        if (!out.getCanonicalPath().startsWith(base)) throw new IOException("Недопустимый путь в архиве");
                        if (e.isDirectory()) { out.mkdirs(); continue; }
                        File parent = out.getParentFile();
                        if (parent != null) parent.mkdirs();
                        try (FileOutputStream fo = new FileOutputStream(out)) {
                            int n;
                            while ((n = zin.read(buf)) > 0) fo.write(buf, 0, n);
                        }
                        read += e.getCompressedSize() > 0 ? e.getCompressedSize() : 0;
                        int pct = size > 0 ? (int) Math.min(100, read * 100 / size) : -1;
                        if (pct != last) { last = pct; progress("unpack", pct); }
                    }
                }
                if (!new File(dir, "index.html").exists() || !new File(dir, "scan.js").exists()) throw new IOException("В обновлении нет нужных файлов");
                zip.delete();
                // старые папки обновлений больше не нужны
                File[] olds = root.listFiles();
                if (olds != null) for (File f : olds) if (!f.equals(dir)) deleteTree(f);
                final String path = dir.getAbsolutePath();
                SharedPreferences prefs = getContext().getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(WebView.CAP_SERVER_PATH, path).apply();
                progress("apply", 100);
                JSObject res = new JSObject();
                res.put("path", path);
                call.resolve(res);
                // переключаем приложение на новую версию (страница перезагрузится сама)
                getActivity().runOnUiThread(() -> getBridge().setServerBasePath(path));
            } catch (Exception e) {
                deleteTree(dir);
                zip.delete();
                call.reject("Обновление не удалось: " + e.getMessage());
            }
        }).start();
    }

    /** Обновление всего приложения: скачать APK и открыть установку. */
    @PluginMethod
    public void updateApk(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("Нет адреса обновления"); return; }
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "update");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("Не удалось создать папку");
                File apk = new File(dir, "defactum-nurse.apk");
                download(url, apk);
                progress("install", 100);
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
            } catch (Exception e) {
                call.reject("Обновление не удалось: " + e.getMessage());
            }
        }).start();
    }
}
