import { ensureConfiguredAcpRouteReady } from "../acp/persistent-bindings.route.js";
import { resolveAckReaction } from "../agents/identity.js";
import { shouldAckReaction as shouldAckReactionGate } from "../channels/ack-reactions.js";
import { logInboundDrop } from "../channels/logging.js";
import { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
import { runSilentMessageIngest } from "../channels/silent-ingest.js";
import {
  createStatusReactionController,
  type StatusReactionController,
} from "../channels/status-reactions.js";
import { loadConfig } from "../config/config.js";
import { resolveChannelGroupIngest } from "../config/group-policy.js";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
} from "../config/types.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { buildAgentSessionKey, deriveLastRoutePolicy } from "../routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID, resolveThreadSessionKeys } from "../routing/session-key.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, normalizeAllowFrom, normalizeDmAllowFromWithStore } from "./bot-access.js";
import { resolveTelegramInboundBody } from "./bot-message-context.body.js";
import { buildTelegramInboundContextPayload } from "./bot-message-context.session.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import {
  buildTypingThreadParams,
  resolveTelegramDirectPeerId,
  resolveTelegramThreadSpec,
} from "./bot/helpers.js";
import { resolveTelegramConversationRoute } from "./conversation-route.js";
import { enforceTelegramDmAccess } from "./dm-access.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";
import {
  buildTelegramStatusReactionVariants,
  resolveTelegramAllowedEmojiReactions,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis,
} from "./status-reaction-variants.js";

export type {
  BuildTelegramMessageContextParams,
  TelegramMediaRef,
} from "./bot-message-context.types.js";

export const buildTelegramMessageContext = async ({
  primaryCtx,
  allMedia,
  replyMedia = [],
  storeAllowFrom,
  options,
  bot,
  cfg,
  account,
  historyLimit,
  groupHistories,
  dmPolicy,
  allowFrom,
  groupAllowFrom,
  ackReactionScope,
  logger,
  resolveGroupActivation,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
  sendChatActionHandler,
}: BuildTelegramMessageContextParams) => {
  const msg = primaryCtx.message;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const threadSpec = resolveTelegramThreadSpec({
    isGroup,
    isForum,
    messageThreadId,
  });
  const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
  const replyThreadId = threadSpec.id;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, threadIdForConfig);
  // Use direct config dmPolicy override if available for DMs
  const effectiveDmPolicy =
    !isGroup && groupConfig && "dmPolicy" in groupConfig
      ? (groupConfig.dmPolicy ?? dmPolicy)
      : dmPolicy;
  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const freshCfg = loadConfig();
  let { route, configuredBinding, configuredBindingSessionKey } = resolveTelegramConversationRoute({
    cfg: freshCfg,
    accountId: account.accountId,
    chatId,
    isGroup,
    resolvedThreadId,
    replyThreadId,
    senderId,
    topicAgentId: topicConfig?.agentId,
  });
  const requiresExplicitAccountBinding = (
    candidate: ReturnType<typeof resolveTelegramConversationRoute>["route"],
  ): boolean => candidate.accountId !== DEFAULT_ACCOUNT_ID && candidate.matchedBy === "default";
  const isNamedAccountFallback = requiresExplicitAccountBinding(route);
  // Named-account groups still require an explicit binding; DMs get a
  // per-account fallback session key below to preserve isolation.
  if (isNamedAccountFallback && isGroup) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "non-default account requires explicit binding",
      target: route.accountId,
    });
    return null;
  }
  // Calculate groupAllowOverride first - it's needed for both DM and group allowlist checks
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const effectiveDmAllow = normalizeDmAllowFromWithStore({
    allowFrom: dmAllowFrom,
    storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  // Group sender checks are explicit and must not inherit DM pairing-store entries.
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? groupAllowFrom);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
  const senderUsername = msg.from?.username ?? "";
  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    enforceAllowOverride: true,
    requireSenderForAllowOverride: false,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
      return null;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return null;
    }
    logVerbose(
      isGroup
        ? `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`
        : `Blocked telegram DM sender ${senderId || "unknown"} (DM allowFrom override)`,
    );
    return null;
  }

  const requireTopic = (groupConfig as TelegramDirectConfig | undefined)?.requireTopic;
  const topicRequiredButMissing = !isGroup && requireTopic === true && dmThreadId == null;
  if (topicRequiredButMissing) {
    logVerbose(`Blocked telegram DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }

  const sendTyping = async () => {
    await withTelegramApiErrorLogging({
      operation: "sendChatAction",
      fn: () =>
        sendChatActionHandler.sendChatAction(
          chatId,
          "typing",
          buildTypingThreadParams(replyThreadId),
        ),
    });
  };

  const sendRecordVoice = async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          sendChatActionHandler.sendChatAction(
            chatId,
            "record_voice",
            buildTypingThreadParams(replyThreadId),
          ),
      });
    } catch (err) {
      logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
    }
  };

  if (
    !(await enforceTelegramDmAccess({
      isGroup,
      dmPolicy: effectiveDmPolicy,
      msg,
      chatId,
      effectiveDmAllow,
      accountId: account.accountId,
      bot,
      logger,
    }))
  ) {
    return null;
  }
  const ensureConfiguredBindingReady = async (): Promise<boolean> => {
    if (!configuredBinding) {
      return true;
    }
    const ensured = await ensureConfiguredAcpRouteReady({
      cfg: freshCfg,
      configuredBinding,
    });
    if (ensured.ok) {
      logVerbose(
        `telegram: using configured ACP binding for ${configuredBinding.spec.conversationId} -> ${configuredBindingSessionKey}`,
      );
      return true;
    }
    logVerbose(
      `telegram: configured ACP binding unavailable for ${configuredBinding.spec.conversationId}: ${ensured.error}`,
    );
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "configured ACP binding unavailable",
      target: configuredBinding.spec.conversationId,
    });
    return false;
  };

  const baseSessionKey = isNamedAccountFallback
    ? buildAgentSessionKey({
        agentId: route.agentId,
        channel: "telegram",
        accountId: route.accountId,
        peer: {
          kind: "direct",
          id: resolveTelegramDirectPeerId({
            chatId,
            senderId,
          }),
        },
        dmScope: "per-account-channel-peer",
        identityLinks: freshCfg.session?.identityLinks,
      }).toLowerCase()
    : route.sessionKey;
  // DMs: use thread suffix for session isolation (works regardless of dmScope)
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${chatId}:${dmThreadId}` })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  route = {
    ...route,
    sessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey: route.mainSessionKey,
    }),
  };
  // Compute requireMention after access checks and final route selection.
  const activationOverride = resolveGroupActivation({
    chatId,
    messageThreadId: resolvedThreadId,
    sessionKey: sessionKey,
    agentId: route.agentId,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId);
  const requireMention = firstDefined(
    activationOverride,
    topicConfig?.requireMention,
    (groupConfig as TelegramGroupConfig | undefined)?.requireMention,
    baseRequireMention,
  );

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });

  const bodyResult = await resolveTelegramInboundBody({
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    routeAgentId: route.agentId,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    requireMention,
    options,
    groupHistories,
    historyLimit,
    logger,
  });
  if (!bodyResult) {
    return null;
  }

  let bodyText = rawBody;
  const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));

  const disableAudioPreflight =
    firstDefined(
      topicConfig?.disableAudioPreflight,
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight,
    ) === true;

  // Preflight audio transcription for mention detection in groups
  // This allows voice notes to be checked for mentions before being dropped
  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    isGroup &&
    requireMention &&
    hasAudio &&
    !hasUserText &&
    mentionRegexes.length > 0 &&
    !disableAudioPreflight;

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await import("../media-understanding/audio-preflight.js");
      // Build a minimal context for transcription
      const tempCtx: MsgContext = {
        MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
        MediaTypes:
          allMedia.length > 0
            ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
            : undefined,
      };
      preflightTranscript = await transcribeFirstAudio({
        ctx: tempCtx,
        cfg,
        agentDir: undefined,
      });
    } catch (err) {
      logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
    }
  }

  // Replace audio placeholder with transcript when preflight succeeds.
  if (hasAudio && bodyText === "<media:audio>" && preflightTranscript) {
    bodyText = preflightTranscript;
  }

  // Build bodyText fallback for messages that still have no text.
  if (!bodyText && allMedia.length > 0) {
    if (hasAudio) {
      bodyText = preflightTranscript || "<media:audio>";
    } else {
      bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
    }
  }

  const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
    (ent) => ent.type === "mention",
  );
  const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;

  const computedWasMentioned = matchesMentionWithExplicit({
    text: msg.text ?? msg.caption ?? "",
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(botUsername),
    },
    transcript: preflightTranscript,
  });
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;
  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "control command (unauthorized)",
      target: senderId ?? "unknown",
    });
    return null;
  }
  // Reply-chain detection: replying to a bot message acts like an implicit mention.
  // Exclude forum-topic service messages (auto-generated "Topic created" etc. messages
  // by the bot) so that every message inside a bot-created topic does not incorrectly
  // bypass requireMention (#32256).
  // We detect service messages by the presence of Telegram's forum_topic_* fields
  // rather than by the absence of text/caption, because legitimate bot media messages
  // (stickers, voice notes, captionless photos) also lack text/caption.
  const botId = primaryCtx.me?.id;
  const replyFromId = msg.reply_to_message?.from?.id;
  const replyToBotMessage = botId != null && replyFromId === botId;
  const isReplyToServiceMessage =
    replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
  const implicitMention = replyToBotMessage && !isReplyToServiceMessage;
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup,
    requireMention: Boolean(requireMention),
    canDetectMention,
    wasMentioned,
    implicitMention: isGroup && Boolean(requireMention) && implicitMention,
    hasAnyMention,
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized,
  });
  const _effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  if (isGroup && requireMention && canDetectMention) {
    if (mentionGate.shouldSkip) {
      logger.info({ chatId, reason: "no-mention" }, "skipping group message");
      recordPendingHistoryEntryIfEnabled({
        historyMap: groupHistories,
        historyKey: historyKey ?? "",
        limit: historyLimit,
        entry: historyKey
          ? {
              sender: buildSenderLabel(msg, senderId || chatId),
              body: rawBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
            }
          : null,
      });

      // Silent ingest: run hooks on non-mentioned messages
      const baseIngestEnabled = resolveChannelGroupIngest({
        cfg,
        channel: "telegram",
        groupId: String(chatId),
        accountId: route.accountId,
      });
      const ingestEnabled =
        typeof topicConfig?.ingest === "boolean" ? topicConfig.ingest : baseIngestEnabled;
      const messageIdForHook =
        typeof msg.message_id === "number" ? String(msg.message_id) : undefined;
      const ingestConversationId = buildTelegramGroupPeerId(chatId, resolvedThreadId);
      const ingestFrom = buildTelegramGroupFrom(chatId, resolvedThreadId);
      void runSilentMessageIngest({
        enabled: ingestEnabled,
        event: {
          from: ingestFrom,
          content: bodyText,
          timestamp: msg.date ? msg.date * 1000 : undefined,
          metadata: {
            to: `telegram:${chatId}`,
            provider: "telegram",
            surface: "telegram",
            threadId: resolvedThreadId,
            originatingChannel: "telegram",
            originatingTo: `telegram:${chatId}`,
            messageId: messageIdForHook,
            senderId: senderId || undefined,
            senderName: buildSenderName(msg),
            senderUsername,
          },
        },
        ctx: {
          channelId: "telegram",
          accountId: route.accountId,
          conversationId: ingestConversationId,
        },
        log: logVerbose,
        logPrefix: "telegram",
      });

      return null;
    }
  }

  if (!(await ensureConfiguredBindingReady())) {
    return null;
  }

  // ACK reactions
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "telegram",
    accountId: account.accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: Boolean(requireMention),
        canDetectMention: bodyResult.canDetectMention,
        effectiveWasMentioned: bodyResult.effectiveWasMentioned,
        shouldBypassMention: bodyResult.shouldBypassMention,
      }),
    );
  const api = bot.api as unknown as {
    setMessageReaction?: (
      chatId: number | string,
      messageId: number,
      reactions: Array<{ type: "emoji"; emoji: string }>,
    ) => Promise<void>;
    getChat?: (chatId: number | string) => Promise<unknown>;
  };
  const reactionApi =
    typeof api.setMessageReaction === "function" ? api.setMessageReaction.bind(api) : null;
  const getChatApi = typeof api.getChat === "function" ? api.getChat.bind(api) : null;

  // Status Reactions controller (lifecycle reactions)
  const statusReactionsConfig = cfg.messages?.statusReactions;
  const statusReactionsEnabled =
    statusReactionsConfig?.enabled === true && Boolean(reactionApi) && shouldAckReaction();
  const resolvedStatusReactionEmojis = resolveTelegramStatusReactionEmojis({
    initialEmoji: ackReaction,
    overrides: statusReactionsConfig?.emojis,
  });
  const statusReactionVariantsByEmoji = buildTelegramStatusReactionVariants(
    resolvedStatusReactionEmojis,
  );
  let allowedStatusReactionEmojisPromise: Promise<Set<string> | null> | null = null;
  const statusReactionController: StatusReactionController | null =
    statusReactionsEnabled && msg.message_id
      ? createStatusReactionController({
          enabled: true,
          adapter: {
            setReaction: async (emoji: string) => {
              if (reactionApi) {
                if (!allowedStatusReactionEmojisPromise) {
                  allowedStatusReactionEmojisPromise = resolveTelegramAllowedEmojiReactions({
                    chat: msg.chat,
                    chatId,
                    getChat: getChatApi ?? undefined,
                  }).catch((err) => {
                    logVerbose(
                      `telegram status-reaction available_reactions lookup failed for chat ${chatId}: ${String(err)}`,
                    );
                    return null;
                  });
                }
                const allowedStatusReactionEmojis = await allowedStatusReactionEmojisPromise;
                const resolvedEmoji = resolveTelegramReactionVariant({
                  requestedEmoji: emoji,
                  variantsByRequestedEmoji: statusReactionVariantsByEmoji,
                  allowedEmojiReactions: allowedStatusReactionEmojis,
                });
                if (!resolvedEmoji) {
                  return;
                }
                await reactionApi(chatId, msg.message_id, [
                  { type: "emoji", emoji: resolvedEmoji },
                ]);
              }
            },
            // Telegram replaces atomically — no removeReaction needed
          },
          initialEmoji: ackReaction,
          emojis: resolvedStatusReactionEmojis,
          timing: statusReactionsConfig?.timing,
          onError: (err) => {
            logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
          },
        })
      : null;

  // When status reactions are enabled, setQueued() replaces the simple ack reaction
  const ackReactionPromise = statusReactionController
    ? shouldAckReaction()
      ? Promise.resolve(statusReactionController.setQueued()).then(
          () => true,
          () => false,
        )
      : null
    : shouldAckReaction() && msg.message_id && reactionApi
      ? withTelegramApiErrorLogging({
          operation: "setMessageReaction",
          fn: () => reactionApi(chatId, msg.message_id, [{ type: "emoji", emoji: ackReaction }]),
        }).then(
          () => true,
          (err) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
            return false;
          },
        )
      : null;

  const { ctxPayload, skillFilter } = await buildTelegramInboundContextPayload({
    cfg,
    primaryCtx,
    msg,
    allMedia,
    replyMedia,
    isGroup,
    isForum,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    dmThreadId,
    threadSpec,
    route,
    rawBody: bodyResult.rawBody,
    bodyText: bodyResult.bodyText,
    historyKey: bodyResult.historyKey,
    historyLimit,
    groupHistories,
    groupConfig,
    topicConfig,
    stickerCacheHit: bodyResult.stickerCacheHit,
    effectiveWasMentioned: bodyResult.effectiveWasMentioned,
    locationData: bodyResult.locationData,
    options,
    dmAllowFrom,
    commandAuthorized: bodyResult.commandAuthorized,
  });

  return {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    resolvedThreadId,
    threadSpec,
    replyThreadId,
    isForum,
    historyKey: bodyResult.historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController,
    accountId: account.accountId,
  };
};

export type TelegramMessageContext = NonNullable<
  Awaited<ReturnType<typeof buildTelegramMessageContext>>
>;
