/**
 * ChatGPT Adapter
 *
 * Export-based adapter for ChatGPT data.
 * Captures conversations, memories, custom instructions, and user profile
 * from a ChatGPT data export (Settings → Data Controls → Export Data).
 *
 * Export structure:
 *   conversations.json  — All conversations (tree-structured mapping)
 *   memories.json       — ChatGPT memories (newer exports)
 *   custom_instructions.json — About user + response preferences
 *   user.json           — User profile metadata
 *   model_comparisons.json — A/B testing data
 *   shared_conversations.json — Publicly shared conversations
 *   message_feedback.json — Thumbs up/down on messages
 *   chat.html           — HTML render of conversations
 *
 * Detection:
 *   - SAVESTATE_CHATGPT_EXPORT env var → path to export directory or zip
 *   - chatgpt-export/ or conversations.json in cwd
 *   - .savestate/imports/chatgpt/ extracted export
 *
 * Restore is partial — ChatGPT has no public API for importing
 * conversations. Generates chatgpt-restore-guide.md with data
 * for manual re-entry.
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  Adapter,
  PlatformMeta,
  Snapshot,
  MemoryEntry,
  ConversationMeta,
  Conversation,
  Message,
} from '../types.js';
import { SAF_VERSION, generateSnapshotId } from '../format.js';

// ─── ChatGPT Export Types ────────────────────────────────────

interface ChatGPTConversation {
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, ChatGPTNode>;
  conversation_id?: string;
  id?: string;
  current_node?: string;
  default_model_slug?: string;
  moderation_results?: unknown[];
  is_archived?: boolean;
}

interface ChatGPTNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTMessage {
  id: string;
  author: { role: string; name?: string; metadata?: Record<string, unknown> };
  create_time: number | null;
  update_time?: number | null;
  content: {
    content_type: string;
    parts?: Array<string | Record<string, unknown>>;
    text?: string;
    result?: string;
  };
  status?: string;
  end_turn?: boolean | null;
  weight?: number;
  metadata?: Record<string, unknown>;
  recipient?: string;
}

interface ChatGPTMemory {
  id: string;
  content: string;
  created_at?: string;
  updated_at?: string;
  // Some exports use timestamp numbers
  create_time?: number;
  update_time?: number;
}

interface ChatGPTCustomInstructions {
  about_user_message?: string;
  about_model_message?: string;
  // Older format keys
  about_user?: string;
  response_preferences?: string;
}

interface ChatGPTUser {
  id?: string;
  email?: string;
  chatgpt_plus_user?: boolean;
  name?: string;
  phone_number?: string;
  picture?: string;
  // Some exports have nested structure
  user?: {
    id?: string;
    email?: string;
    name?: string;
  };
}

// ─── Constants ───────────────────────────────────────────────

const PROGRESS_INTERVAL = 500; // Log progress every N conversations

// ─── Adapter ─────────────────────────────────────────────────

export class ChatGPTAdapter implements Adapter {
  readonly id = 'chatgpt';
  readonly name = 'ChatGPT';
  readonly platform = 'chatgpt';
  readonly version = '0.1.0';

  private exportDir: string = '';
  private warnings: string[] = [];

  async detect(): Promise<boolean> {
    const resolved = this.resolveExportPath();
    return resolved !== null;
  }

  async extract(): Promise<Snapshot> {
    this.warnings = [];

    const exportPath = this.resolveExportPath();
    if (!exportPath) {
      throw new Error(
        'ChatGPT export not found.\n' +
        'Provide the path via:\n' +
        '  • SAVESTATE_CHATGPT_EXPORT env var (path to export directory or zip)\n' +
        '  • Place chatgpt-export/ or conversations.json in the current directory\n' +
        '  • Extract export to .savestate/imports/chatgpt/\n\n' +
        'Export your data from ChatGPT: Settings → Data Controls → Export Data',
      );
    }
    this.exportDir = exportPath;
    this.log(`Using ChatGPT export from: ${this.exportDir}`);

    // 1. Parse user profile
    this.log('Reading user profile...');
    const userInfo = await this.readUserJson();

    // 2. Parse custom instructions → identity.personality
    this.log('Reading custom instructions...');
    const { personality, instructionCount } = await this.readCustomInstructions();

    // 3. Parse memories → memory.core
    this.log('Reading memories...');
    const memories = await this.readMemories();

    // 4. Parse conversations → conversations + conversation details
    this.log('Reading conversations...');
    const { conversationMetas, conversationEntries } = await this.readConversations();

    // Summary
    this.log(
      `Found ${conversationMetas.length} conversations, ` +
      `${memories.length} memories, ` +
      `${instructionCount} custom instructions`,
    );

    // Build snapshot
    const snapshotId = generateSnapshotId();
    const now = new Date().toISOString();

    // Build config from user info
    const config: Record<string, unknown> = {};
    if (userInfo) {
      config.user = userInfo;
    }

    // Store conversation data as memory entries so they survive the snapshot format
    // (the conversations index only has metadata, not full messages)
    const allMemory: MemoryEntry[] = [...memories, ...conversationEntries];

    if (this.warnings.length > 0) {
      for (const w of this.warnings) {
        console.warn(`  ⚠ ${w}`);
      }
    }

    const snapshot: Snapshot = {
      manifest: {
        version: SAF_VERSION,
        timestamp: now,
        id: snapshotId,
        platform: this.platform,
        adapter: this.id,
        checksum: '',
        size: 0,
      },
      identity: {
        personality: personality || undefined,
        config: Object.keys(config).length > 0 ? config : undefined,
        tools: [],
      },
      memory: {
        core: allMemory,
        knowledge: [],
      },
      conversations: {
        total: conversationMetas.length,
        conversations: conversationMetas,
      },
      platform: await this.identify(),
      chain: {
        current: snapshotId,
        ancestors: [],
      },
      restoreHints: {
        platform: this.platform,
        steps: [
          {
            type: 'file',
            description: 'Generate restore guide with memories and custom instructions',
            target: 'chatgpt-restore-guide.md',
          },
          {
            type: 'manual',
            description: 'Re-enter custom instructions in ChatGPT settings',
            target: 'Settings → Personalization → Custom Instructions',
          },
          {
            type: 'manual',
            description: 'Review and re-add memories via ChatGPT memory settings',
            target: 'Settings → Personalization → Memory',
          },
        ],
        manualSteps: [
          'ChatGPT does not support importing conversations via API',
          'Custom instructions must be manually re-entered in Settings → Personalization',
          'Memories can be viewed but must be re-added manually or through conversation',
          'Conversation history cannot be restored — it is preserved in the snapshot for reference',
        ],
      },
    };

    this.log(`✓ Extraction complete`);
    return snapshot;
  }

  async restore(snapshot: Snapshot): Promise<void> {
    this.warnings = [];

    const outputDir = process.cwd();
    const guidePath = join(outputDir, 'chatgpt-restore-guide.md');

    this.log('ChatGPT restore is partial — generating restore guide...');

    const guide = this.buildRestoreGuide(snapshot);
    await writeFile(guidePath, guide, 'utf-8');

    // Also write memories to a separate file for easy reference
    const memoriesFromCore = snapshot.memory.core.filter(m => m.source === 'chatgpt-memory');
    if (memoriesFromCore.length > 0) {
      const memoriesPath = join(outputDir, 'chatgpt-memories.md');
      const memoriesDoc = this.buildMemoriesDoc(memoriesFromCore);
      await writeFile(memoriesPath, memoriesDoc, 'utf-8');
      this.log(`  Wrote ${memoriesFromCore.length} memories to chatgpt-memories.md`);
    }

    // Write custom instructions if present
    if (snapshot.identity.personality) {
      const instructionsPath = join(outputDir, 'chatgpt-custom-instructions.md');
      const instructionsDoc = this.buildInstructionsDoc(snapshot.identity.personality);
      await writeFile(instructionsPath, instructionsDoc, 'utf-8');
      this.log('  Wrote custom instructions to chatgpt-custom-instructions.md');
    }

    console.error('');
    console.error('┌─────────────────────────────────────────────────────┐');
    console.error('│  ⚠ ChatGPT restore is partial                       │');
    console.error('├─────────────────────────────────────────────────────┤');
    console.error('│  See chatgpt-restore-guide.md for instructions.     │');
    console.error('│  Conversations are preserved but cannot be imported. │');
    console.error('│  Memories and custom instructions require manual     │');
    console.error('│  re-entry in ChatGPT settings.                      │');
    console.error('└─────────────────────────────────────────────────────┘');

    if (this.warnings.length > 0) {
      console.error('');
      for (const w of this.warnings) {
        console.warn(`  ⚠ ${w}`);
      }
    }
  }

  async identify(): Promise<PlatformMeta> {
    return {
      name: 'ChatGPT',
      version: this.version,
      exportMethod: 'data-export',
    };
  }

  // ─── Private: Export Path Resolution ───────────────────────

  /**
   * Resolve the export directory path from env var, cwd, or .savestate/imports/.
   * Returns null if no valid export is found.
   */
  private resolveExportPath(): string | null {
    // 1. SAVESTATE_CHATGPT_EXPORT env var
    const envPath = process.env.SAVESTATE_CHATGPT_EXPORT;
    if (envPath) {
      // If it ends with .zip, we don't support direct zip reading (yet).
      // Require pre-extracted.
      if (envPath.endsWith('.zip')) {
        // Check if there's an extracted directory next to the zip
        const extractedDir = envPath.replace(/\.zip$/, '');
        if (existsSync(extractedDir) && this.hasExportFiles(extractedDir)) {
          return extractedDir;
        }
        // Check if the zip name suggests a directory exists
        const parentDir = join(extractedDir, '..');
        const possibleDirs = ['chatgpt-export', basename(extractedDir)];
        for (const dir of possibleDirs) {
          const candidate = join(parentDir, dir);
          if (existsSync(candidate) && this.hasExportFiles(candidate)) {
            return candidate;
          }
        }
        return null; // Zip not yet extracted
      }

      if (existsSync(envPath) && this.hasExportFiles(envPath)) {
        return envPath;
      }
      return null;
    }

    // 2. chatgpt-export/ in current directory
    const chatgptExportDir = join(process.cwd(), 'chatgpt-export');
    if (existsSync(chatgptExportDir) && this.hasExportFiles(chatgptExportDir)) {
      return chatgptExportDir;
    }

    // 3. conversations.json directly in current directory
    const conversationsJson = join(process.cwd(), 'conversations.json');
    if (existsSync(conversationsJson)) {
      return process.cwd();
    }

    // 4. .savestate/imports/chatgpt/
    const savestateImports = join(process.cwd(), '.savestate', 'imports', 'chatgpt');
    if (existsSync(savestateImports) && this.hasExportFiles(savestateImports)) {
      return savestateImports;
    }

    return null;
  }

  /**
   * Check if a directory contains ChatGPT export files.
   */
  private hasExportFiles(dir: string): boolean {
    // Must have at least conversations.json
    return existsSync(join(dir, 'conversations.json'));
  }

  // ─── Private: File Parsers ─────────────────────────────────

  /**
   * Safely read and parse a JSON file from the export directory.
   */
  private async readJsonFile<T>(filename: string): Promise<T | null> {
    const filePath = join(this.exportDir, filename);
    if (!existsSync(filePath)) return null;

    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err) {
      this.warn(`Failed to parse ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Read user.json for profile metadata.
   */
  private async readUserJson(): Promise<Record<string, unknown> | null> {
    const data = await this.readJsonFile<ChatGPTUser>('user.json');
    if (!data) return null;

    // Normalize nested structure
    const user = data.user ?? data;
    return {
      id: user.id ?? data.id,
      email: user.email ?? data.email,
      name: user.name ?? data.name,
      chatgpt_plus_user: data.chatgpt_plus_user,
    };
  }

  /**
   * Read custom_instructions.json and build personality string.
   */
  private async readCustomInstructions(): Promise<{ personality: string; instructionCount: number }> {
    const data = await this.readJsonFile<ChatGPTCustomInstructions>('custom_instructions.json');
    if (!data) return { personality: '', instructionCount: 0 };

    const parts: string[] = [];
    let count = 0;

    // Handle both old and new format keys
    const aboutUser = data.about_user_message ?? data.about_user;
    const responsePrefs = data.about_model_message ?? data.response_preferences;

    if (aboutUser) {
      parts.push(`--- About User (Custom Instructions) ---\n${aboutUser}`);
      count++;
    }

    if (responsePrefs) {
      parts.push(`--- Response Preferences (Custom Instructions) ---\n${responsePrefs}`);
      count++;
    }

    return {
      personality: parts.join('\n\n'),
      instructionCount: count,
    };
  }

  /**
   * Read memories.json into MemoryEntry array.
   */
  private async readMemories(): Promise<MemoryEntry[]> {
    const data = await this.readJsonFile<ChatGPTMemory[]>('memories.json');
    if (!data || !Array.isArray(data)) return [];

    return data.map(mem => {
      const createdAt = mem.created_at
        ?? (mem.create_time ? new Date(mem.create_time * 1000).toISOString() : new Date().toISOString());
      const updatedAt = mem.updated_at
        ?? (mem.update_time ? new Date(mem.update_time * 1000).toISOString() : undefined);

      return {
        id: `chatgpt-memory:${mem.id}`,
        content: mem.content,
        source: 'chatgpt-memory',
        createdAt,
        updatedAt,
        metadata: { platform: 'chatgpt' },
      };
    });
  }

  /**
   * Read conversations.json, walk tree structures, and produce metadata + entries.
   */
  private async readConversations(): Promise<{
    conversationMetas: ConversationMeta[];
    conversationEntries: MemoryEntry[];
  }> {
    const data = await this.readJsonFile<ChatGPTConversation[]>('conversations.json');
    if (!data || !Array.isArray(data)) return { conversationMetas: [], conversationEntries: [] };

    const conversationMetas: ConversationMeta[] = [];
    const conversationEntries: MemoryEntry[] = [];
    const total = data.length;
    const isLarge = total >= 1000;

    if (isLarge) {
      this.log(`  Processing ${total} conversations (this may take a moment)...`);
    }

    for (let i = 0; i < data.length; i++) {
      const conv = data[i];

      // Progress logging for large exports
      if (isLarge && i > 0 && i % PROGRESS_INTERVAL === 0) {
        this.log(`  Progress: ${i}/${total} conversations processed...`);
      }

      try {
        const messages = this.walkConversationTree(conv);
        const convId = conv.conversation_id ?? conv.id ?? this.hashString(conv.title + conv.create_time);

        const createdAt = conv.create_time
          ? new Date(conv.create_time * 1000).toISOString()
          : new Date().toISOString();
        const updatedAt = conv.update_time
          ? new Date(conv.update_time * 1000).toISOString()
          : createdAt;

        conversationMetas.push({
          id: convId,
          title: conv.title || undefined,
          createdAt,
          updatedAt,
          messageCount: messages.length,
          path: `conversations/${convId}.json`,
        });

        // Store conversation messages as a memory entry for snapshot persistence
        const conversation: Conversation = {
          id: convId,
          title: conv.title || undefined,
          createdAt,
          updatedAt,
          messages,
          metadata: {
            default_model: conv.default_model_slug,
            is_archived: conv.is_archived,
          },
        };

        conversationEntries.push({
          id: `conversation:${convId}`,
          content: JSON.stringify(conversation),
          source: 'chatgpt-conversation',
          createdAt,
          updatedAt,
          metadata: {
            title: conv.title,
            messageCount: messages.length,
            model: conv.default_model_slug,
          },
        });
      } catch (err) {
        this.warn(
          `Failed to parse conversation "${conv.title ?? 'unknown'}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (isLarge) {
      this.log(`  Processed all ${total} conversations.`);
    }

    return { conversationMetas, conversationEntries };
  }

  // ─── Private: Tree Walking ─────────────────────────────────

  /**
   * Walk the conversation tree (mapping) and produce a linear list of messages.
   *
   * Algorithm:
   * 1. Find root node (parent is null or missing)
   * 2. Walk children depth-first
   * 3. When a node has multiple children (branching = user edited), take the last branch
   * 4. Skip null/system messages without content
   * 5. Collect messages in order
   */
  private walkConversationTree(conv: ChatGPTConversation): Message[] {
    const mapping = conv.mapping;
    if (!mapping || Object.keys(mapping).length === 0) return [];

    // Find root node(s) — node with no parent or parent not in mapping
    const rootNodes = Object.values(mapping).filter(
      node => !node.parent || !mapping[node.parent],
    );

    if (rootNodes.length === 0) return [];

    // Start from the first root (there should usually be exactly one)
    const root = rootNodes[0];
    const messages: Message[] = [];

    this.collectMessages(root, mapping, messages);

    return messages;
  }

  /**
   * Recursively collect messages by walking the tree depth-first.
   * For branches (multiple children), take the last child (most recent edit/branch).
   */
  private collectMessages(
    node: ChatGPTNode,
    mapping: Record<string, ChatGPTNode>,
    messages: Message[],
  ): void {
    // Extract message from this node if it exists and has content
    if (node.message) {
      const msg = this.extractMessage(node.message);
      if (msg) {
        messages.push(msg);
      }
    }

    // Walk children — take the last child when branching
    if (node.children.length > 0) {
      // Last child = most recent branch (user edited and continued from latest)
      const nextChildId = node.children[node.children.length - 1];
      const nextChild = mapping[nextChildId];
      if (nextChild) {
        this.collectMessages(nextChild, mapping, messages);
      }
    }
  }

  /**
   * Extract a Message from a ChatGPT message node.
   * Returns null if the message should be skipped (system, empty, etc.)
   */
  private extractMessage(msg: ChatGPTMessage): Message | null {
    const role = msg.author.role;

    // Skip system messages and empty messages
    if (role === 'system') return null;

    // Extract text content
    const text = this.extractContent(msg.content);
    if (!text) return null;

    // Map roles: user, assistant, tool
    let mappedRole: 'user' | 'assistant' | 'system' | 'tool';
    if (role === 'user') {
      mappedRole = 'user';
    } else if (role === 'assistant') {
      mappedRole = 'assistant';
    } else if (role === 'tool') {
      mappedRole = 'tool';
    } else {
      // Unknown role — treat as system and skip
      return null;
    }

    const timestamp = msg.create_time
      ? new Date(msg.create_time * 1000).toISOString()
      : new Date().toISOString();

    return {
      id: msg.id,
      role: mappedRole,
      content: text,
      timestamp,
      metadata: {
        ...(msg.metadata?.model_slug ? { model: msg.metadata.model_slug } : {}),
        ...(msg.author.name ? { author_name: msg.author.name } : {}),
        ...(msg.recipient && msg.recipient !== 'all' ? { recipient: msg.recipient } : {}),
        ...(msg.status ? { status: msg.status } : {}),
      },
    };
  }

  /**
   * Extract text from ChatGPT content structure.
   * Handles content_type: "text", "code", "tether_browsing_display", etc.
   */
  private extractContent(content: {
    content_type: string;
    parts?: Array<string | Record<string, unknown>>;
    text?: string;
    result?: string;
  }): string | null {
    if (!content) return null;

    // Direct text field
    if (content.text) return content.text;

    // Result field (for tool outputs)
    if (content.result) return content.result;

    // Parts array
    if (content.parts && Array.isArray(content.parts)) {
      const textParts: string[] = [];
      for (const part of content.parts) {
        if (typeof part === 'string') {
          if (part.trim()) textParts.push(part);
        } else if (part && typeof part === 'object') {
          // Image, file, or other structured content
          if ('text' in part && typeof part.text === 'string') {
            textParts.push(part.text);
          } else if ('asset_pointer' in part) {
            textParts.push('[Image]');
          } else if ('content_type' in part && part.content_type === 'image_asset_pointer') {
            textParts.push('[Image]');
          }
        }
      }
      const joined = textParts.join('\n');
      return joined || null;
    }

    return null;
  }

  // ─── Private: Restore Guide Generation ─────────────────────

  /**
   * Build the chatgpt-restore-guide.md content.
   */
  private buildRestoreGuide(snapshot: Snapshot): string {
    const lines: string[] = [];

    lines.push('# ChatGPT Restore Guide');
    lines.push('');
    lines.push(`Generated by SaveState on ${new Date().toISOString()}`);
    lines.push(`Snapshot ID: ${snapshot.manifest.id}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## ⚠️ Important');
    lines.push('');
    lines.push('ChatGPT does not support importing conversations or memories via API.');
    lines.push('This guide contains your data for manual re-entry.');
    lines.push('');

    // Custom Instructions
    if (snapshot.identity.personality) {
      lines.push('## Custom Instructions');
      lines.push('');
      lines.push('Go to **ChatGPT → Settings → Personalization → Custom Instructions**');
      lines.push('and copy the following:');
      lines.push('');
      lines.push('```');
      lines.push(snapshot.identity.personality);
      lines.push('```');
      lines.push('');
    }

    // Memories
    const memories = snapshot.memory.core.filter(m => m.source === 'chatgpt-memory');
    if (memories.length > 0) {
      lines.push('## Memories');
      lines.push('');
      lines.push(`You had ${memories.length} memories. To re-create them, you can:`);
      lines.push('1. Mention these facts in conversations and ChatGPT will learn them');
      lines.push('2. Go to **Settings → Personalization → Memory → Manage** to review');
      lines.push('');
      for (const mem of memories) {
        lines.push(`- ${mem.content}`);
      }
      lines.push('');
    }

    // Conversation summary
    if (snapshot.conversations.total > 0) {
      lines.push('## Conversations');
      lines.push('');
      lines.push(`Your export contained ${snapshot.conversations.total} conversations.`);
      lines.push('These are preserved in the snapshot but cannot be imported into ChatGPT.');
      lines.push('Use `savestate inspect` to browse them.');
      lines.push('');

      // Show a few recent ones
      const recent = snapshot.conversations.conversations
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20);

      if (recent.length > 0) {
        lines.push('### Recent Conversations');
        lines.push('');
        lines.push('| Date | Title | Messages |');
        lines.push('|------|-------|----------|');
        for (const conv of recent) {
          const date = conv.updatedAt.slice(0, 10);
          const title = conv.title ?? '(untitled)';
          lines.push(`| ${date} | ${title} | ${conv.messageCount} |`);
        }
        lines.push('');
      }
    }

    // Platform info
    const config = snapshot.identity.config as Record<string, unknown> | undefined;
    if (config?.user) {
      const user = config.user as Record<string, unknown>;
      lines.push('## Account Info');
      lines.push('');
      if (user.email) lines.push(`- Email: ${user.email}`);
      if (user.name) lines.push(`- Name: ${user.name}`);
      if (user.chatgpt_plus_user) lines.push('- Plan: ChatGPT Plus');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build a standalone memories document.
   */
  private buildMemoriesDoc(memories: MemoryEntry[]): string {
    const lines: string[] = [];
    lines.push('# ChatGPT Memories');
    lines.push('');
    lines.push(`Exported ${memories.length} memories.`);
    lines.push('');
    lines.push('To restore these, mention them in conversations with ChatGPT');
    lines.push('or manually add them in Settings → Personalization → Memory.');
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const mem of memories) {
      const date = mem.createdAt.slice(0, 10);
      lines.push(`- **[${date}]** ${mem.content}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Build a standalone custom instructions document.
   */
  private buildInstructionsDoc(personality: string): string {
    const lines: string[] = [];
    lines.push('# ChatGPT Custom Instructions');
    lines.push('');
    lines.push('Copy these into ChatGPT → Settings → Personalization → Custom Instructions.');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(personality);
    lines.push('');
    return lines.join('\n');
  }

  // ─── Private: Utilities ────────────────────────────────────

  private log(msg: string): void {
    console.error(msg);
  }

  private warn(msg: string): void {
    this.warnings.push(msg);
  }

  /**
   * Simple string hash for generating IDs when conversation_id is missing.
   */
  private hashString(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }
}
