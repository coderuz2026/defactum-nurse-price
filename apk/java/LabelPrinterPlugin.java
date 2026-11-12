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

import java.io.File;
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
}
