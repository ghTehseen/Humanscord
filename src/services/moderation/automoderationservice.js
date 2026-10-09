import { PermissionFlagsBits } from 'discord.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { getGuildConfig, patchGuildConfig } from '../config/guildConfig.js';
import { DEFAULT_AUTOMOD_CONFIG } from '../../config/moderation/defaults.js';
import { logModerationAction } from '../../utils/moderation.js';
import { WarningService } from './warningService.js';
import { logger } from '../../utils/logger.js';
import { memberHasConfiguredModeratorRole } from '../../utils/permissionGuard.js';
import { isBotOwner } from '../../config/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOCKED_TERMS_PATH = path.join(__dirname, '../../config/moderation/blockedTerms.json');

const INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/[a-z0-9-]+/i;
const LINK_REGEX = /https?:\/\/[^\s<]+/i;
const ZALGO_REGEX = /[\u0300-\u036f]{4,}/;
const LEET_MAP = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '$': 's',
  '@': 'a',
};

const spamBuckets = new Map();
const strikeBuckets = new Map();

let cachedTerms = null;

function loadBlockedTerms() {
  if (cachedTerms) {
    return cachedTerms;
  }

  try {
    const raw = JSON.parse(readFileSync(BLOCKED_TERMS_PATH, 'utf8'));
    cachedTerms = {
      words: normalizeTermList(raw.words),
      phrases: normalizeTermList(raw.phrases),
    };
  } catch (error) {
    logger.error('Failed to load blockedTerms.json, using empty lists:', error);
    cachedTerms = { words: [], phrases: [] };
  }

  return cachedTerms;
}

function normalizeTermList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return [...new Set(
    list
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )];
}

export function mergeAutomodConfig(raw = {}) {
  const base = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULT_AUTOMOD_CONFIG,
    ...base,
    exemptRoles: Array.isArray(base.exemptRoles) ? base.exemptRoles : [],
    exemptChannels: Array.isArray(base.exemptChannels) ? base.exemptChannels : [],
    ignoredWords: normalizeTermList(base.ignoredWords),
    customWords: normalizeTermList(base.customWords),
    customPhrases: normalizeTermList(base.customPhrases),
    filters: {
      ...DEFAULT_AUTOMOD_CONFIG.filters,
      ...(base.filters && typeof base.filters === 'object' ? base.filters : {}),
    },
  };
}

export async function saveAutomodConfig(client, guildId, automod) {
  return patchGuildConfig(client, guildId, { automod: mergeAutomodConfig(automod) });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContent(content = '') {
  return String(content)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[0-9$@]/g, (char) => LEET_MAP[char] || char)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactContent(normalized) {
  return normalized.replace(/\s+/g, '');
}

function findListedMatch(normalized, compact, terms, ignoreSet, asPhrase) {
  for (const term of terms) {
    if (!term || ignoreSet.has(term)) {
      continue;
    }

    if (asPhrase) {
      if (normalized.includes(term) || compact.includes(term.replace(/\s+/g, ''))) {
        return term;
      }
      continue;
    }

    if (term.length <= 3) {
      const bounded = new RegExp(`(?:^|\\s)${escapeRegex(term)}(?:$|\\s)`);
      if (bounded.test(normalized)) {
        return term;
      }
      continue;
    }

    const bounded = new RegExp(`(?:^|\\s)${escapeRegex(term)}(?:$|\\s)`);
    if (bounded.test(normalized) || compact.includes(term.replace(/\s+/g, ''))) {
      return term;
    }
  }

  return null;
}

function pruneBucket(bucket, windowMs, now) {
  while (bucket.length && now - bucket[0] > windowMs) {
    bucket.shift();
  }
}

function recordHit(map, key, windowMs) {
  const now = Date.now();
  const bucket = map.get(key) || [];
  pruneBucket(bucket, windowMs, now);
  bucket.push(now);
  map.set(key, bucket);
  return bucket.length;
}

function isExemptMember(message, automod, guildConfig) {
  const member = message.member;
  if (!member) {
    return false;
  }

  if (isBotOwner(member.id) || member.id === message.guild.ownerId) {
    return true;
  }

  if (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  if (memberHasConfiguredModeratorRole(member, guildConfig)) {
    return true;
  }

  return automod.exemptRoles.some((roleId) => member.roles.cache.has(roleId));
}

export function evaluateMessage(message, automod) {
  const filters = automod.filters;
  const content = message.content || '';
  const fileTerms = loadBlockedTerms();
  const ignoreSet = new Set(automod.ignoredWords);
  const normalized = normalizeContent(content);
  const compact = compactContent(normalized);
  const reasons = [];
  let matchedTerm = null;

  if (filters.words) {
    const words = [...fileTerms.words, ...automod.customWords];
    const hit = findListedMatch(normalized, compact, words, ignoreSet, false);
    if (hit) {
      reasons.push('blocked word');
      matchedTerm = hit;
    }
  }

  if (filters.phrases) {
    const phrases = [...fileTerms.phrases, ...automod.customPhrases];
    const hit = findListedMatch(normalized, compact, phrases, ignoreSet, true);
    if (hit) {
      reasons.push('blocked phrase');
      matchedTerm = matchedTerm || hit;
    }
  }

  if (filters.invites && INVITE_REGEX.test(content)) {
    reasons.push('discord invite');
  }

  if (filters.links && LINK_REGEX.test(content) && !INVITE_REGEX.test(content)) {
    reasons.push('external link');
  }

  if (filters.massMentions) {
    const uniqueMentions = new Set(message.mentions.users.keys());
    const everyone = message.mentions.everyone;
    const limit = Number(filters.massMentionLimit) || 5;
    if (everyone || uniqueMentions.size > limit) {
      reasons.push('mass mentions');
    }
  }

  if (filters.caps) {
    const letters = content.replace(/[^A-Za-z]/g, '');
    const minLength = Number(filters.capsMinLength) || 16;
    const percent = Number(filters.capsPercent) || 75;
    if (letters.length >= minLength) {
      const upper = letters.replace(/[^A-Z]/g, '').length;
      if ((upper / letters.length) * 100 >= percent) {
        reasons.push('excessive caps');
      }
    }
  }

  if (filters.zalgo && ZALGO_REGEX.test(content)) {
    reasons.push('zalgo text');
  }

  if (filters.spam) {
    const key = `${message.guild.id}:${message.author.id}:${compact || content.toLowerCase()}`;
    const count = recordHit(spamBuckets, key, Number(filters.spamWindowMs) || 8000);
    if (count >= (Number(filters.spamCount) || 5)) {
      reasons.push('repeated spam');
    }
  }

  return {
    triggered: reasons.length > 0,
    reasons,
    matchedTerm,
  };
}

async function applyTimeoutIfNeeded(message, automod) {
  if (!automod.timeoutOnRepeat) {
    return false;
  }

  const member = message.member;
  if (!member?.moderatable) {
    return false;
  }

  const key = `${message.guild.id}:${message.author.id}`;
  const hits = recordHit(strikeBuckets, key, automod.strikeWindowMs || DEFAULT_AUTOMOD_CONFIG.strikeWindowMs);
  if (hits < (automod.strikeLimit || DEFAULT_AUTOMOD_CONFIG.strikeLimit)) {
    return false;
  }

  const durationMs = Math.max(1, Number(automod.timeoutMinutes) || 10) * 60 * 1000;
  await member.timeout(durationMs, 'AutoMod repeated filter strikes');
  strikeBuckets.delete(key);
  return true;
}

export async function scanAndEnforceMessage(message, client) {
  if (!message?.guild || message.author?.bot) {
    return false;
  }

  const guildConfig = await getGuildConfig(client, message.guild.id);
  const automod = mergeAutomodConfig(guildConfig.automod);

  if (!automod.enabled) {
    return false;
  }

  if (automod.exemptChannels.includes(message.channelId)) {
    return false;
  }

  if (isExemptMember(message, automod, guildConfig)) {
    return false;
  }

  const result = evaluateMessage(message, automod);
  if (!result.triggered) {
    return false;
  }

  const reason = result.reasons.join(', ');
  let deleted = false;

  if (automod.deleteMessage && message.deletable) {
    await message.delete().catch((error) => {
      logger.warn('AutoMod could not delete message:', error);
    });
    deleted = true;
  }

  if (automod.warnOnFilter) {
    await WarningService.addWarning({
      guildId: message.guild.id,
      userId: message.author.id,
      moderatorId: client.user.id,
      reason: `AutoMod: ${reason}`,
      timestamp: Date.now(),
    }).catch((error) => {
      logger.warn('AutoMod could not add warning:', error);
    });
  }

  const timedOut = await applyTimeoutIfNeeded(message, automod).catch((error) => {
    logger.warn('AutoMod could not timeout member:', error);
    return false;
  });

  await logModerationAction({
    client,
    guild: message.guild,
    event: {
      action: 'AutoMod Triggered',
      target: `${message.author.tag} (${message.author.id})`,
      executor: `${client.user.tag} (${client.user.id})`,
      reason,
      metadata: {
        userId: message.author.id,
        moderatorId: client.user.id,
        channelId: message.channelId,
        matchedTerm: result.matchedTerm,
        deleted,
        timedOut,
        filters: result.reasons,
      },
    },
  }).catch((error) => {
    logger.warn('AutoMod could not write moderation log:', error);
  });

  if (deleted) {
    await message.channel.send({
      content: `${message.author}, that message was removed by AutoMod (${reason}).`,
    }).catch(() => {});
  }

  return true;
}
