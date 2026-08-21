import type {
  ActionDefinition,
  ActionRegistry,
  DispatchRequest,
  Effects,
  ExecutionEnvelope,
  JsonSchema
} from "./index.js";

export declare const DEFAULT_CHANNEL: "action-parity:call";
export declare const DEFAULT_CATALOG_CHANNEL: "action-parity:catalog";

/** Structurally typed so the SDK never imports Electron. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: never[]) => unknown): void;
  removeHandler?(channel: string): void;
}

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export interface ElectronBridgeOptions {
  channel?: string;
  catalogChannel?: string;
  /** The Surface ID the main process reports as. Defaults to "gui". */
  surface?: string;
  /** Reject renderers that must not reach this Action. */
  authorizeSender?: (
    event: unknown,
    context: { actionId: string; surface: string }
  ) => boolean | Promise<boolean>;
  /**
   * Re-ask for confirmation in the main process for Actions that require it.
   * A renderer claim is not treated as evidence of human consent.
   */
  confirm?: (context: {
    action: ActionDefinition;
    request: Record<string, unknown>;
    event: unknown;
    surface: string;
  }) => boolean | Promise<boolean>;
  actor?: (event: unknown) => unknown | Promise<unknown>;
}

export declare function attachElectronIpc(
  ipcMain: IpcMainLike,
  registry: ActionRegistry,
  options?: ElectronBridgeOptions
): () => void;

export interface GuiCatalogAction {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  effects: Effects;
  confirmation_required: boolean;
  /** The stable non-visual identifier a GUI control should carry. */
  data_action_id: string;
}

export declare function guiCatalog(
  registry: ActionRegistry,
  surface?: string
): {
  application: { id: string; name: string; version: string };
  surface: string;
  actions: GuiCatalogAction[];
};

export declare function createRendererClient(
  ipcRenderer: IpcRendererLike,
  options?: { channel?: string }
): <TResult = unknown>(
  actionId: string,
  input?: unknown,
  callOptions?: Partial<DispatchRequest>
) => Promise<ExecutionEnvelope<TResult>>;

export declare function createInProcessClient(
  registry: ActionRegistry,
  surface?: string
): <TResult = unknown>(
  actionId: string,
  input?: unknown,
  overrides?: Partial<DispatchRequest>
) => Promise<ExecutionEnvelope<TResult>>;
