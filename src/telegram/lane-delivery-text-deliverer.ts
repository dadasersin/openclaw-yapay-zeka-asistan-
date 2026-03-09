import type { ReplyPayload } from "../auto-reply/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";

const MESSAGE_NOT_MODIFIED_RE =
  /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_NOT_FOUND_RE =
  /400:\s*Bad Request:\s*message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i;

function isMessageNotModifiedError(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err && "description" in err
          ? typeof err.description === "string"
            ? err.description
            : ""
          : "";
  return MESSAGE_NOT_MODIFIED_RE.test(text);
}

function isMissingPreviewMessageError(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err && "description" in err
          ? typeof err.description === "string"
            ? err.description
            : ""
          : "";
  return MESSAGE_NOT_FOUND_RE.test(text);
}

export type LaneName = "answer" | "reasoning";

export type DraftLaneState = {
  stream: TelegramDraftStream | undefined;
  lastPartialText: string;
  hasStreamedMessage: boolean;
};

export type LaneDeliveryResult = "preview-finalized" | "preview-updated" | "sent" | "skipped";

type CreateLaneTextDelivererParams = {
  lanes: Record<LaneName, DraftLaneState>;
  finalizedPreviewByLane: Record<LaneName, boolean>;
  draftMaxChars: number;
  applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
  sendPayload: (payload: ReplyPayload) => Promise<boolean>;
  flushDraftLane: (lane: DraftLaneState) => Promise<void>;
  stopDraftLane: (lane: DraftLaneState) => Promise<void>;
  editPreview: (params: {
    laneName: LaneName;
    messageId: number;
    text: string;
    context: "final" | "update";
    previewButtons?: TelegramInlineButtons;
  }) => Promise<void>;
  log: (message: string) => void;
  markDelivered: () => void;
};

type DeliverLaneTextParams = {
  laneName: LaneName;
  text: string;
  sendText?: string;
  payload: ReplyPayload;
  infoKind: string;
  previewButtons?: TelegramInlineButtons;
  allowPreviewUpdateForNonFinal?: boolean;
};

type TryUpdatePreviewParams = {
  lane: DraftLaneState;
  laneName: LaneName;
  text: string;
  previewButtons?: TelegramInlineButtons;
  stopBeforeEdit?: boolean;
  updateLaneSnapshot?: boolean;
  skipRegressive: "always" | "existingOnly";
  context: "final" | "update";
  previewMessageId?: number;
  previewTextSnapshot?: string;
};

type PreviewUpdateContext = "final" | "update";
type RegressiveSkipMode = "always" | "existingOnly";

type ResolvePreviewTargetParams = {
  lane: DraftLaneState;
  previewMessageIdOverride?: number;
  stopBeforeEdit: boolean;
  context: PreviewUpdateContext;
};

type PreviewTargetResolution = {
  hadPreviewMessage: boolean;
  previewMessageId: number | undefined;
  stopCreatesFirstPreview: boolean;
};

function shouldSkipRegressivePreviewUpdate(args: {
  currentPreviewText: string | undefined;
  text: string;
  skipRegressive: RegressiveSkipMode;
  hadPreviewMessage: boolean;
}): boolean {
  const currentPreviewText = args.currentPreviewText;
  if (currentPreviewText === undefined) {
    return false;
  }
  return (
    currentPreviewText.startsWith(args.text) &&
    args.text.length < currentPreviewText.length &&
    (args.skipRegressive === "always" || args.hadPreviewMessage)
  );
}

function resolvePreviewTarget(params: ResolvePreviewTargetParams): PreviewTargetResolution {
  const lanePreviewMessageId = params.lane.stream?.messageId();
  const previewMessageId =
    typeof params.previewMessageIdOverride === "number"
      ? params.previewMessageIdOverride
      : lanePreviewMessageId;
  const hadPreviewMessage =
    typeof params.previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
  return {
    hadPreviewMessage,
    previewMessageId: typeof previewMessageId === "number" ? previewMessageId : undefined,
    stopCreatesFirstPreview:
      params.stopBeforeEdit && !hadPreviewMessage && params.context === "final",
  };
}

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const getLanePreviewText = (lane: DraftLaneState) => lane.lastPartialText;
  const isDraftPreviewLane = (lane: DraftLaneState) => lane.stream?.previewMode?.() === "draft";
  const markLaneDelivered = (lane: DraftLaneState, text: string) => {
    lane.lastPartialText = text;
    params.markDelivered();
  };
  const canMaterializeDraftFinal = (
    lane: DraftLaneState,
    previewButtons?: TelegramInlineButtons,
  ) => {
    const hasPreviewButtons = Boolean(previewButtons && previewButtons.length > 0);
    return (
      isDraftPreviewLane(lane) &&
      !hasPreviewButtons &&
      typeof lane.stream?.materialize === "function"
    );
  };

  const tryMaterializeDraftPreviewForFinal = async (args: {
    lane: DraftLaneState;
    laneName: LaneName;
    text: string;
  }): Promise<boolean> => {
    const stream = args.lane.stream;
    if (!stream || !isDraftPreviewLane(args.lane)) {
      return false;
    }
    // Draft previews have no message_id to edit; materialize the final text
    // into a real message and treat that as the finalized delivery.
    stream.update(args.text);
    const materializedMessageId = await stream.materialize?.();
    if (typeof materializedMessageId !== "number") {
      params.log(
        `telegram: ${args.laneName} draft preview materialize produced no message id; falling back to standard send`,
      );
      return false;
    }
    markLaneDelivered(args.lane, args.text);
    return true;
  };

  const tryEditPreviewMessage = async (args: {
    laneName: LaneName;
    messageId: number;
    text: string;
    context: "final" | "update";
    previewButtons?: TelegramInlineButtons;
    updateLaneSnapshot: boolean;
    lane: DraftLaneState;
    treatEditFailureAsDelivered: boolean;
  }): Promise<boolean> => {
    try {
      await params.editPreview({
        laneName: args.laneName,
        messageId: args.messageId,
        text: args.text,
        previewButtons: args.previewButtons,
        context: args.context,
      });
      if (args.updateLaneSnapshot || args.context === "final") {
        args.lane.lastPartialText = args.text;
      }
      params.markDelivered();
      return true;
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        if (args.context === "final") {
          args.lane.lastPartialText = args.text;
        }
        params.log(
          `telegram: ${args.laneName} preview ${args.context} edit returned "message is not modified"; treating as delivered`,
        );
        params.markDelivered();
        return true;
      }
      if (args.treatEditFailureAsDelivered) {
        if (isMissingPreviewMessageError(err)) {
          params.log(
            `telegram: ${args.laneName} preview ${args.context} edit target missing; falling back to standard send (${String(err)})`,
          );
          return false;
        }
        if (args.context === "final") {
          args.lane.lastPartialText = args.text;
        }
        params.log(
          `telegram: ${args.laneName} preview ${args.context} edit failed; keeping existing preview (${String(err)})`,
        );
        params.markDelivered();
        return true;
      }
      params.log(
        `telegram: ${args.laneName} preview ${args.context} edit failed; falling back to standard send (${String(err)})`,
      );
      return false;
    }
  };

  const tryUpdatePreviewForLane = async ({
    lane,
    laneName,
    text,
    previewButtons,
    stopBeforeEdit = false,
    updateLaneSnapshot = false,
    skipRegressive,
    context,
    previewMessageId: previewMessageIdOverride,
    previewTextSnapshot,
  }: TryUpdatePreviewParams): Promise<boolean> => {
    const editPreview = (messageId: number, treatEditFailureAsDelivered: boolean) =>
      tryEditPreviewMessage({
        laneName,
        messageId,
        text,
        context,
        previewButtons,
        updateLaneSnapshot,
        lane,
        treatEditFailureAsDelivered,
      });
    const finalizePreview = (
      previewMessageId: number,
      treatEditFailureAsDelivered: boolean,
      hadPreviewMessage: boolean,
    ): boolean | Promise<boolean> => {
      const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
      const shouldSkipRegressive = shouldSkipRegressivePreviewUpdate({
        currentPreviewText,
        text,
        skipRegressive,
        hadPreviewMessage,
      });
      if (shouldSkipRegressive) {
        params.markDelivered();
        return true;
      }
      return editPreview(previewMessageId, treatEditFailureAsDelivered);
    };
    if (!lane.stream) {
      return false;
    }
    const previewTargetBeforeStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit,
      context,
    });
    if (previewTargetBeforeStop.stopCreatesFirstPreview) {
      // Final stop() can create the first visible preview message.
      // Prime pending text so the stop flush sends the final text snapshot.
      lane.stream.update(text);
      await params.stopDraftLane(lane);
      const previewTargetAfterStop = resolvePreviewTarget({
        lane,
        stopBeforeEdit: false,
        context,
      });
      if (typeof previewTargetAfterStop.previewMessageId !== "number") {
        return false;
      }
      return finalizePreview(previewTargetAfterStop.previewMessageId, true, false);
    }
    if (stopBeforeEdit) {
      await params.stopDraftLane(lane);
    }
    const previewTargetAfterStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit: false,
      context,
    });
    if (typeof previewTargetAfterStop.previewMessageId !== "number") {
      return false;
    }
    return finalizePreview(
      previewTargetAfterStop.previewMessageId,
      context === "final",
      previewTargetAfterStop.hadPreviewMessage,
    );
  };

  return async ({
    laneName,
    text,
    sendText,
    payload,
    infoKind,
    previewButtons,
    allowPreviewUpdateForNonFinal = false,
  }: DeliverLaneTextParams): Promise<LaneDeliveryResult> => {
    const lane = params.lanes[laneName];
    const deliveredPayloadText = sendText ?? text;
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const canEditViaPreview =
      !hasMedia && text.length > 0 && text.length <= params.draftMaxChars && !payload.isError;

    if (infoKind === "final") {
      if (canEditViaPreview && !params.finalizedPreviewByLane[laneName]) {
        await params.flushDraftLane(lane);
        if (canMaterializeDraftFinal(lane, previewButtons)) {
          const materialized = await tryMaterializeDraftPreviewForFinal({
            lane,
            laneName,
            text,
          });
          if (materialized) {
            params.finalizedPreviewByLane[laneName] = true;
            return "preview-finalized";
          }
        }
        const finalized = await tryUpdatePreviewForLane({
          lane,
          laneName,
          text,
          previewButtons,
          stopBeforeEdit: true,
          skipRegressive: "existingOnly",
          context: "final",
        });
        if (finalized) {
          params.finalizedPreviewByLane[laneName] = true;
          return "preview-finalized";
        }
      } else if (!hasMedia && !payload.isError && text.length > params.draftMaxChars) {
        params.log(
          `telegram: preview final too long for edit (${text.length} > ${params.draftMaxChars}); falling back to standard send`,
        );
      }
      await params.stopDraftLane(lane);
      const delivered = await params.sendPayload(
        params.applyTextToPayload(payload, deliveredPayloadText),
      );
      if (delivered) {
        lane.lastPartialText = deliveredPayloadText;
      }
      return delivered ? "sent" : "skipped";
    }

    if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
      if (isDraftPreviewLane(lane)) {
        // DM draft flow has no message_id to edit; updates are sent via sendMessageDraft.
        // Only mark as updated when the draft flush actually emits an update.
        const previewRevisionBeforeFlush = lane.stream?.previewRevision?.() ?? 0;
        lane.stream?.update(text);
        await params.flushDraftLane(lane);
        const previewUpdated = (lane.stream?.previewRevision?.() ?? 0) > previewRevisionBeforeFlush;
        if (!previewUpdated) {
          params.log(
            `telegram: ${laneName} draft preview update not emitted; falling back to standard send`,
          );
          const delivered = await params.sendPayload(
            params.applyTextToPayload(payload, deliveredPayloadText),
          );
          return delivered ? "sent" : "skipped";
        }
        lane.lastPartialText = text;
        params.markDelivered();
        return "preview-updated";
      }
      const updated = await tryUpdatePreviewForLane({
        lane,
        laneName,
        text,
        previewButtons,
        stopBeforeEdit: false,
        updateLaneSnapshot: true,
        skipRegressive: "always",
        context: "update",
      });
      if (updated) {
        return "preview-updated";
      }
    }

    const delivered = await params.sendPayload(
      params.applyTextToPayload(payload, deliveredPayloadText),
    );
    return delivered ? "sent" : "skipped";
  };
}
