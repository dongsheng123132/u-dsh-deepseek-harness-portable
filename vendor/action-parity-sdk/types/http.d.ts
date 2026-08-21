import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActionRegistry, ErrorClass } from "./index.js";

/** HTTP status per error class. */
export declare const STATUS_FOR_CLASS: Readonly<Record<ErrorClass, number>>;

/** Codes whose HTTP meaning differs from their Action Core class. */
export declare const STATUS_FOR_CODE: Readonly<Record<string, number>>;

export interface HttpHandlerOptions {
  /** Path prefix, for example "/api". Defaults to the server root. */
  basePath?: string;
  /** The Surface ID this transport reports as. Defaults to "api". */
  surface?: string;
  /** Return the actor, or a falsy value to answer 401. */
  authenticate?: (request: IncomingMessage) => unknown | Promise<unknown>;
}

export declare function createHttpHandler(
  registry: ActionRegistry,
  options?: HttpHandlerOptions
): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
