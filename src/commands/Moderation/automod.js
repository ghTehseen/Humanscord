import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import {
  mergeAutomodConfig,
  saveAutomodConfig,
} from '../../services/moderation/autoModerationService.js';
import { AUTOMOD_FILTER_CHOICES } from '../../config/moderation/defaults.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const blockedTermsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../config/moderation/blockedTerms.json',
);

function loadFileLists() {
  try {
    const raw = JSON.parse(readFileSync(blockedTermsPath, 'utf8'));
    return {
      words: Array.isArray(raw.words) ? raw.words : [],
      phrases: Array.isArray(raw.phrases) ? raw.phrases : [],
    };
  } catch {
    return { words: [], phrases: [] };
  }
}

function formatOnOff(value) {
  return value ? 'on' : 'off';
}

function addUnique(list, value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return list;
  }
  if (list.includes(normalized)) {
    return list;
  }
  return [...list, normalized];
}

function removeValue(list, value) {
  const normalized = value.trim().toLowerCase();
  return list.filter((item) => item !== normalized);
}

export default {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure AutoMod word, phrase, and chat filters for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('Show the current AutoMod settings.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('toggle')
        .setDescription('Turn AutoMod on or off.')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('Whether AutoMod is enabled.').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('filter')
        .setDescription('Enable or disable a specific AutoMod filter.')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Filter to change.')
            .setRequired(true)
            .addChoices(...AUTOMOD_FILTER_CHOICES),
        )
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('Turn this filter on or off.').setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('word')
        .setDescription('Manage extra blocked words for this server.')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('add')
            .setDescription('Block an extra word in this server.')
            .addStringOption((option) =>
              option.setName('term').setDescription('Word to block.').setRequired(true).setMaxLength(64),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('remove')
            .setDescription('Unblock a custom word.')
            .addStringOption((option) =>
              option.setName('term').setDescription('Word to remove.').setRequired(true).setMaxLength(64),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('list').setDescription('List built-in and custom blocked words.'),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('phrase')
        .setDescription('Manage extra blocked phrases for this server.')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('add')
            .setDescription('Block an extra phrase in this server.')
            .addStringOption((option) =>
              option.setName('term').setDescription('Phrase to block.').setRequired(true).setMaxLength(100),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('remove')
            .setDescription('Unblock a custom phrase.')
            .addStringOption((option) =>
              option.setName('term').setDescription('Phrase to remove.').setRequired(true).setMaxLength(100),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('list').setDescription('List built-in and custom blocked phrases.'),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('ignore')
        .setDescription('Allow a built-in blocked word in this server.')
        .addStringOption((option) =>
          option.setName('term').setDescription('Word or phrase to ignore.').setRequired(true).setMaxLength(100),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('exempt')
        .setDescription('Exempt a role or channel from AutoMod.')
        .addRoleOption((option) =>
          option.setName('role').setDescription('Role that AutoMod should skip.'),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel that AutoMod should skip.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addBooleanOption((option) =>
          option.setName('remove').setDescription('Set true to remove the exemption.'),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('actions')
        .setDescription('Choose what AutoMod does when a filter hits.')
        .addBooleanOption((option) =>
          option.setName('delete').setDescription('Delete the matching message.'),
        )
        .addBooleanOption((option) =>
          option.setName('warn').setDescription('Add an automatic warning.'),
        )
        .addBooleanOption((option) =>
          option.setName('timeout_repeat').setDescription('Timeout after repeated hits.'),
        ),
    ),
  category: 'moderation',

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { ephemeral: true });
    if (!deferSuccess) {
      logger.warn('Automod interaction defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'automod',
      });
      return;
    }

    const guildConfig = await getGuildConfig(client, interaction.guildId);
    const automod = mergeAutomodConfig(guildConfig.automod);
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'status') {
      const fileLists = loadFileLists();
      const filterLines = AUTOMOD_FILTER_CHOICES
        .map((choice) => `• ${choice.name}: **${formatOnOff(automod.filters[choice.value])}**`)
        .join('\n');

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          infoEmbed(
            'AutoMod status',
            [
              `**Enabled:** ${formatOnOff(automod.enabled)}`,
              `**Delete messages:** ${formatOnOff(automod.deleteMessage)}`,
              `**Auto-warn:** ${formatOnOff(automod.warnOnFilter)}`,
              `**Timeout on repeat:** ${formatOnOff(automod.timeoutOnRepeat)}`,
              `**Built-in words:** ${fileLists.words.length} · **custom:** ${automod.customWords.length}`,
              `**Built-in phrases:** ${fileLists.phrases.length} · **custom:** ${automod.customPhrases.length}`,
              `**Exempt roles:** ${automod.exemptRoles.length} · **exempt channels:** ${automod.exemptChannels.length}`,
              '',
              filterLines,
              '',
              'Turn it on with `/automod toggle enabled:True`. Lists live in `src/config/moderation/blockedTerms.json`.',
            ].join('\n'),
          ),
        ],
      });
      return;
    }

    if (subcommand === 'toggle') {
      automod.enabled = interaction.options.getBoolean('enabled');
      await saveAutomodConfig(client, interaction.guildId, automod);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('AutoMod updated', `AutoMod is now **${formatOnOff(automod.enabled)}**.`)],
      });
      return;
    }

    if (subcommand === 'filter') {
      const name = interaction.options.getString('name');
      const enabled = interaction.options.getBoolean('enabled');
      automod.filters[name] = enabled;
      await saveAutomodConfig(client, interaction.guildId, automod);
      const label = AUTOMOD_FILTER_CHOICES.find((choice) => choice.value === name)?.name || name;
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Filter updated', `**${label}** is now **${formatOnOff(enabled)}**.`)],
      });
      return;
    }

    if (group === 'word' || group === 'phrase') {
      const listKey = group === 'word' ? 'customWords' : 'customPhrases';
      const fileKey = group === 'word' ? 'words' : 'phrases';

      if (subcommand === 'add') {
        const term = interaction.options.getString('term');
        automod[listKey] = addUnique(automod[listKey], term);
        await saveAutomodConfig(client, interaction.guildId, automod);
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(`${group} added`, `\`${term.trim().toLowerCase()}\` is now blocked in this server.`)],
        });
        return;
      }

      if (subcommand === 'remove') {
        const term = interaction.options.getString('term');
        automod[listKey] = removeValue(automod[listKey], term);
        await saveAutomodConfig(client, interaction.guildId, automod);
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(`${group} removed`, `\`${term.trim().toLowerCase()}\` is no longer a custom block.`)],
        });
        return;
      }

      const fileLists = loadFileLists();
      const builtIn = fileLists[fileKey];
      const custom = automod[listKey];
      const builtInPreview = builtIn.slice(0, 20).map((item) => `\`${item}\``).join(', ') || '*none*';
      const customPreview = custom.map((item) => `\`${item}\``).join(', ') || '*none*';
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          infoEmbed(
            `Blocked ${fileKey}`,
            `**Built-in (${builtIn.length}):** ${builtInPreview}${builtIn.length > 20 ? ' …' : ''}\n**Custom:** ${customPreview}`,
          ),
        ],
      });
      return;
    }

    if (subcommand === 'ignore') {
      const term = interaction.options.getString('term');
      automod.ignoredWords = addUnique(automod.ignoredWords, term);
      await saveAutomodConfig(client, interaction.guildId, automod);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ignore added', `\`${term.trim().toLowerCase()}\` will no longer be filtered.`)],
      });
      return;
    }

    if (subcommand === 'exempt') {
      const role = interaction.options.getRole('role');
      const channel = interaction.options.getChannel('channel');
      const remove = interaction.options.getBoolean('remove') || false;

      if (!role && !channel) {
        throw new TitanBotError(
          'Missing exemption target',
          ErrorTypes.USER_INPUT,
          'Choose a role and/or a channel to exempt.',
        );
      }

      if (role) {
        automod.exemptRoles = remove
          ? automod.exemptRoles.filter((id) => id !== role.id)
          : [...new Set([...automod.exemptRoles, role.id])];
      }
      if (channel) {
        automod.exemptChannels = remove
          ? automod.exemptChannels.filter((id) => id !== channel.id)
          : [...new Set([...automod.exemptChannels, channel.id])];
      }

      await saveAutomodConfig(client, interaction.guildId, automod);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Exemption updated', remove ? 'The exemption was removed.' : 'AutoMod will skip that role/channel.')],
      });
      return;
    }

    if (subcommand === 'actions') {
      const deleteMessage = interaction.options.getBoolean('delete');
      const warn = interaction.options.getBoolean('warn');
      const timeoutRepeat = interaction.options.getBoolean('timeout_repeat');

      if (deleteMessage === null && warn === null && timeoutRepeat === null) {
        throw new TitanBotError(
          'No action provided',
          ErrorTypes.USER_INPUT,
          'Set at least one of delete, warn, or timeout_repeat.',
        );
      }

      if (deleteMessage !== null) automod.deleteMessage = deleteMessage;
      if (warn !== null) automod.warnOnFilter = warn;
      if (timeoutRepeat !== null) automod.timeoutOnRepeat = timeoutRepeat;

      await saveAutomodConfig(client, interaction.guildId, automod);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            'Actions updated',
            `Delete: **${formatOnOff(automod.deleteMessage)}** · Warn: **${formatOnOff(automod.warnOnFilter)}** · Timeout on repeat: **${formatOnOff(automod.timeoutOnRepeat)}**`,
          ),
        ],
      });
    }
  },
};
