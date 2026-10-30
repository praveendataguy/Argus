import { paypalMode } from "../config.js";
import { instrument } from "../observability.js";
import type { PayPalGateway } from "./gateway.js";
import { PayPalRestGateway } from "./rest.js";
import { PayPalSimulatorGateway } from "./simulator.js";

export const simulator: PayPalGateway = instrument(new PayPalSimulatorGateway(), "simulator");
export const paypal: PayPalGateway = paypalMode === "sandbox" ? instrument(new PayPalRestGateway(), "sandbox") : simulator;

/**
 * Seeded demo history has no real PayPal capture behind it, so money movement
 * on those rows goes to the simulator; anything that came through real sandbox
 * checkout goes to PayPal.
 */
export const gatewayFor = (source: string): PayPalGateway => (source === "paypal-sandbox" ? paypal : simulator);
export type { PayPalGateway } from "./gateway.js";
