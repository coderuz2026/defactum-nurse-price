package uz.defactum.nurse;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LabelPrinterPlugin.class);
        super.onCreate(savedInstanceState);

        // Кнопка «Назад»: сначала спрашиваем само приложение — оно возвращается на предыдущий экран.
        // Только с главного экрана приложение сворачивается (не закрывается, данные на экране сохраняются).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                try {
                    getBridge().getWebView().evaluateJavascript(
                        "(function(){try{return window.__dfBack?window.__dfBack():false}catch(e){return false}})()",
                        value -> { if (!"true".equals(value)) moveTaskToBack(true); }
                    );
                } catch (Exception e) {
                    moveTaskToBack(true);
                }
            }
        });
    }
}
