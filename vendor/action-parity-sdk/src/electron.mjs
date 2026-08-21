/**
 * The Electron GUI Shadow.
 *
 * The renderer never owns business behavior. It sends an Action ID and an
 * input object over one IPC channel; the main process forwards them to the
 * Action Core. Adding an Action changes no code in this file and no preload
 * allowlist, because the channel is per-application, not per-Action.
 *
 * Confirmation is deliberately re-asked in the main process when a `confirm`
 * callback is supplied: a renderer is the least trustworthy part of an Electron
 * app, so a destructive Action must not be confirmable by whatever the renderer
 * decides to put in the payload.
 */

import { confirmationRequired } from "./registry.mjs";

export const DEFAULT_CHANNEL = "action-parity:call";
export const DEFAULT_CATALOG_CHANNEL = "action-parity:catalog";

/**
 * Wire an `ipcMain` to the registry. Returns a function that removes both
 * handlers, so tests and hot reload do not leak listeners.
 */
export function attachElectronIpc(ipcMain, registry, options = {}) {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const catalogChannel = options.catalogChannel ?? DEFAULT_CATALOG_CHANNEL;
  const surface = options.surface ?? "gui";

  ipcMain.handle(channel, async (event, request = {}) => {
    const actionId = request.actionId ?? request.action_id ?? "";
    const action = registry.action(actionId);

    if (options.authorizeSender) {
      const allowed = await options.authorizeSender(event, { actionId, surface });
      if (allowed === false) {
        return {
          ok: false,
          version: 1,
          action_id: actionId,
          execution_id: request.executionId ?? "",
          error: {
            class: "refused",
            code: "sender_not_allowed",
            message: "The main process refused this renderer."
          }
        };
      }
    }

    let confirmed = request.confirmed === true;
    if (options.confirm && action && confirmationRequired(action.effects)) {
      // Ask in the main process; a renderer claim is not evidence of consent.
      confirmed = (await options.confirm({ action, request, event, surface })) === true;
    }

    return registry.dispatch({
      actionId,
      input: request.input ?? {},
      surface,
      confirmed,
      ...(request.executionId ? { executionId: request.executionId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.expectedStateVersion !== undefined
        ? { expectedStateVersion: request.expectedStateVersion }
        : {}),
      actor: options.actor ? await options.actor(event) : null
    });
  });

  ipcMain.handle(catalogChannel, () => guiCatalog(registry, surface));

  return () => {
    ipcMain.removeHandler?.(channel);
    ipcMain.removeHandler?.(catalogChannel);
  };
}

/**
 * What the renderer needs to draw controls and label them with stable,
 * non-visual identifiers. `data_action_id` is the attribute a parity check
 * reads, so "which Action is this button bound to" stays machine-answerable
 * without screenshots.
 */
export function guiCatalog(registry, surface = "gui") {
  return {
    application: registry.application,
    surface,
    actions: registry.actionsForSurface(surface).map((action) => ({
      id: action.id,
      title: action.title,
      description: action.description,
      tags: action.tags,
      input_schema: action.input.jsonSchema,
      output_schema: action.output.jsonSchema,
      effects: action.effects,
      confirmation_required: confirmationRequired(action.effects),
      data_action_id: action.id
    }))
  };
}

/**
 * Build the renderer-side caller, normally inside a preload script:
 *
 *   contextBridge.exposeInMainWorld("actions", {
 *     call: createRendererClient(ipcRenderer),
 *     catalog: () => ipcRenderer.invoke(DEFAULT_CATALOG_CHANNEL)
 *   });
 */
export function createRendererClient(ipcRenderer, options = {}) {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  return (actionId, input = {}, callOptions = {}) =>
    ipcRenderer.invoke(channel, { actionId, input, ...callOptions });
}

/**
 * An in-process client for the same registry, for unit tests and for Electron
 * code that already runs in the main process. Same envelope, no IPC hop.
 */
export function createInProcessClient(registry, surface = "gui") {
  return registry.clientFor(surface);
}
