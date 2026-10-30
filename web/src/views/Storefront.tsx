import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useState } from "react";
import { api, usd } from "../api";
import type { AppConfig } from "../types";

type Cart = Record<string, number>;

/**
 * A tiny shop for the demo merchant. Checkout runs through PayPal Orders v2;
 * every capture is handed to Risk Sentinel before the order ships.
 */
export function Storefront({ config }: { config: AppConfig }) {
  const [cart, setCart] = useState<Cart>({});
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lines = Object.entries(cart).filter(([, q]) => q > 0);
  const total = lines.reduce((s, [sku, q]) => s + (config.catalog.find((p) => p.sku === sku)?.price ?? 0) * q, 0);
  const payload = { cart: lines.map(([sku, quantity]) => ({ sku, quantity })) };
  const add = (sku: string, d: number) => setCart((c) => ({ ...c, [sku]: Math.max(0, (c[sku] ?? 0) + d) }));

  const finish = (r: { transactionId: string }) => {
    setDone(r.transactionId);
    setCart({});
  };

  return (
    <div className="store">
      <div className="store-head">
        <h2>{config.merchant.name}</h2>
        <p className="muted">{config.merchant.tagline}. Buy something, then watch the Command Center.</p>
      </div>
      <div className="products">
        {config.catalog.map((p) => (
          <div key={p.sku} className="product">
            <div className="emoji">{p.emoji}</div>
            <div className="pname">{p.name}</div>
            <div className="muted small">{p.blurb}</div>
            <div className="row-between">
              <b>{usd(p.price)}</b>
              <div className="qty">
                <button onClick={() => add(p.sku, -1)} aria-label={`Remove ${p.name}`}>−</button>
                <span>{cart[p.sku] ?? 0}</span>
                <button onClick={() => add(p.sku, 1)} aria-label={`Add ${p.name}`}>+</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <aside className="checkout panel">
        <h3>Cart · {usd(total)}</h3>
        {done && <div className="answer">✅ Paid. Order {done} is now being screened by Risk Sentinel.</div>}
        {error && <div className="answer">⚠️ {error}</div>}
        {lines.length > 0 &&
          (config.paypalMode === "sandbox" && config.paypalClientId ? (
            <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: "USD", intent: "capture" }}>
              <PayPalButtons
                style={{ layout: "vertical", shape: "rect", label: "paypal" }}
                forceReRender={[total]}
                createOrder={async () => (await api<{ id: string }>("/checkout/orders", payload)).id}
                onApprove={async (data) => finish(await api(`/checkout/orders/${data.orderID}/capture`, {}))}
                onError={(err) => setError(String(err))}
              />
            </PayPalScriptProvider>
          ) : (
            <button
              className="paypal-sim"
              onClick={async () => {
                setError(null);
                try {
                  const order = await api<{ id: string }>("/checkout/orders", payload);
                  finish(await api(`/checkout/orders/${order.id}/capture`, {}));
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Pay with <b>PayPal</b> <small>(simulator)</small>
            </button>
          ))}
        {lines.length === 0 && !done && <p className="muted">Your cart is empty.</p>}
      </aside>
    </div>
  );
}
