import { Node as ProsemirrorNode, Fragment } from "prosemirror-model";
import { Step } from "prosemirror-transform";
import { Transaction, EditorState } from "prosemirror-state";

/**
 * Delta operation types for efficient history storage
 */
export type DeltaOperation =
  | { type: "retain"; count: number }
  | { type: "insert"; content: ProsemirrorNode | Fragment; from: number }
  | { type: "delete"; from: number; to: number; content: ProsemirrorNode | Fragment };

/**
 * History entry representing a single change or group of changes
 */
export interface HistoryEntry {
  /** Unique identifier for this history entry */
  id: string;
  /** Timestamp when the change was made */
  timestamp: number;
  /** ID of the chunk that was modified (or 'global' for cross-chunk) */
  chunkId: string;
  /** Forward delta operations */
  operations: DeltaOperation[];
  /** Inverse operations for undo */
  inverseOperations: DeltaOperation[];
  /** Optional metadata */
  metadata?: {
    userId?: string;
    description?: string;
    [key: string]: any;
  };
}

/**
 * Configuration for history manager
 */
export interface HistoryConfig {
  /** Maximum number of undo steps to keep (default: 100) */
  maxHistory?: number;
  /** Maximum time between changes to group them together in ms (default: 500) */
  groupingDelay?: number;
  /** Whether to compress history entries (default: true) */
  enableCompression?: boolean;
}

/**
 * Chunked History Manager
 *
 * Provides efficient undo/redo for large documents using delta-based storage.
 * Instead of storing full document snapshots, stores only the changes.
 *
 * Benefits:
 * - Significantly reduced memory usage for large documents
 * - Faster undo/redo operations
 * - Supports cross-chunk undo/redo
 * - Configurable history limits
 *
 * Phase 4 Scope:
 * - Delta-based storage for memory efficiency
 * - Undo/redo across chunk boundaries
 * - History limits and cleanup
 * - Compression of redundant operations
 */
export class ChunkedHistoryManager {
  private history: HistoryEntry[] = [];
  private historyIndex: number = 0;
  private config: Required<HistoryConfig>;
  private lastChangeTime: number = 0;
  private pendingGroup: HistoryEntry | null = null;

  constructor(config: HistoryConfig = {}) {
    this.config = {
      maxHistory: config.maxHistory ?? 100,
      groupingDelay: config.groupingDelay ?? 500,
      enableCompression: config.enableCompression ?? true,
    };
  }

  /**
   * Record a transaction in history
   */
  public recordTransaction(
    tr: Transaction,
    chunkId: string,
    userId?: string
  ): void {
    if (!tr.docChanged || tr.getMeta("addToHistory") === false) {
      return;
    }

    const now = Date.now();
    const operations = this.transactionToDeltas(tr);
    const inverseOperations = this.invertDeltas(operations, tr.before);

    const entry: HistoryEntry = {
      id: `history-${now}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: now,
      chunkId,
      operations,
      inverseOperations,
      metadata: {
        userId,
        stepCount: tr.steps.length,
      },
    };

    // Group consecutive changes together
    if (this.shouldGroupWithPrevious(now)) {
      this.mergeIntoPendingGroup(entry);
    } else {
      this.flushPendingGroup();
      this.pendingGroup = entry;
    }

    this.lastChangeTime = now;
  }

  /**
   * Undo the last change
   */
  public undo(): HistoryEntry | null {
    this.flushPendingGroup();

    if (!this.canUndo()) {
      return null;
    }

    this.historyIndex--;
    return this.history[this.historyIndex];
  }

  /**
   * Redo the last undone change
   */
  public redo(): HistoryEntry | null {
    if (!this.canRedo()) {
      return null;
    }

    const entry = this.history[this.historyIndex];
    this.historyIndex++;
    return entry;
  }

  /**
   * Check if undo is possible
   */
  public canUndo(): boolean {
    this.flushPendingGroup();
    return this.historyIndex > 0;
  }

  /**
   * Check if redo is possible
   */
  public canRedo(): boolean {
    return this.historyIndex < this.history.length;
  }

  /**
   * Clear all history
   */
  public clear(): void {
    this.history = [];
    this.historyIndex = 0;
    this.pendingGroup = null;
    this.lastChangeTime = 0;
  }

  /**
   * Get current memory usage estimate in bytes
   */
  public getMemoryUsage(): number {
    let totalSize = 0;

    for (const entry of this.history) {
      // Rough estimate: count operations and metadata
      totalSize += entry.operations.length * 100; // ~100 bytes per operation
      totalSize += entry.inverseOperations.length * 100;
      totalSize += JSON.stringify(entry.metadata || {}).length;
    }

    return totalSize;
  }

  /**
   * Get history statistics
   */
  public getStats() {
    return {
      totalEntries: this.history.length,
      currentIndex: this.historyIndex,
      memoryUsage: this.getMemoryUsage(),
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      oldestEntry: this.history[0]?.timestamp,
      newestEntry: this.history[this.history.length - 1]?.timestamp,
    };
  }

  /**
   * Convert transaction to delta operations
   */
  private transactionToDeltas(tr: Transaction): DeltaOperation[] {
    const operations: DeltaOperation[] = [];
    let offset = 0;

    tr.steps.forEach((step) => {
      const stepJson = step.toJSON();

      if (stepJson.stepType === "replace") {
        const from = (stepJson.from as number) + offset;
        const to = (stepJson.to as number) + offset;

        if (stepJson.slice) {
          // Delete old content if any
          if (from < to) {
            const deleted = tr.before.cut(from, to);
            operations.push({
              type: "delete",
              from,
              to,
              content: deleted,
            });
          }

          // Insert new content if any
          const slice = stepJson.slice;
          if (slice.content && slice.content.length > 0) {
            const inserted = tr.doc.cut(from, from + slice.content.length);
            operations.push({
              type: "insert",
              from,
              content: inserted,
            });
            offset += slice.content.length - (to - from);
          } else {
            offset -= to - from;
          }
        }
      } else if (stepJson.stepType === "replaceAround") {
        // Handle more complex replacements
        operations.push({
          type: "retain",
          count: stepJson.from as number,
        });
      }
    });

    return this.config.enableCompression
      ? this.compressOperations(operations)
      : operations;
  }

  /**
   * Invert delta operations for undo
   */
  private invertDeltas(
    operations: DeltaOperation[],
    doc: ProsemirrorNode
  ): DeltaOperation[] {
    const inverted: DeltaOperation[] = [];

    for (const op of operations) {
      if (op.type === "insert") {
        // Invert insert -> delete
        const insertedSize =
          op.content instanceof Fragment
            ? op.content.size
            : op.content.nodeSize;
        inverted.push({
          type: "delete",
          from: op.from,
          to: op.from + insertedSize,
          content: op.content,
        });
      } else if (op.type === "delete") {
        // Invert delete -> insert
        inverted.push({
          type: "insert",
          from: op.from,
          content: op.content,
        });
      } else {
        // Retain stays the same
        inverted.push(op);
      }
    }

    return inverted.reverse();
  }

  /**
   * Compress consecutive retain operations
   */
  private compressOperations(operations: DeltaOperation[]): DeltaOperation[] {
    const compressed: DeltaOperation[] = [];
    let lastRetainCount = 0;

    for (const op of operations) {
      if (op.type === "retain") {
        lastRetainCount += op.count;
      } else {
        if (lastRetainCount > 0) {
          compressed.push({ type: "retain", count: lastRetainCount });
          lastRetainCount = 0;
        }
        compressed.push(op);
      }
    }

    if (lastRetainCount > 0) {
      compressed.push({ type: "retain", count: lastRetainCount });
    }

    return compressed;
  }

  /**
   * Check if we should group this change with the previous one
   */
  private shouldGroupWithPrevious(now: number): boolean {
    if (!this.pendingGroup) {
      return false;
    }

    const timeSinceLastChange = now - this.lastChangeTime;
    return timeSinceLastChange < this.config.groupingDelay;
  }

  /**
   * Merge entry into pending group
   */
  private mergeIntoPendingGroup(entry: HistoryEntry): void {
    if (!this.pendingGroup) {
      this.pendingGroup = entry;
      return;
    }

    // Merge operations
    this.pendingGroup.operations.push(...entry.operations);
    this.pendingGroup.inverseOperations.unshift(...entry.inverseOperations);

    // Update metadata
    if (this.pendingGroup.metadata && entry.metadata) {
      this.pendingGroup.metadata.stepCount =
        (this.pendingGroup.metadata.stepCount || 0) +
        (entry.metadata.stepCount || 0);
    }

    // Compress merged operations
    if (this.config.enableCompression) {
      this.pendingGroup.operations = this.compressOperations(
        this.pendingGroup.operations
      );
      this.pendingGroup.inverseOperations = this.compressOperations(
        this.pendingGroup.inverseOperations
      );
    }
  }

  /**
   * Flush pending group to history
   */
  private flushPendingGroup(): void {
    if (!this.pendingGroup) {
      return;
    }

    // Remove any entries after current index (they've been undone)
    this.history = this.history.slice(0, this.historyIndex);

    // Add new entry
    this.history.push(this.pendingGroup);
    this.historyIndex = this.history.length;

    // Enforce history limit
    if (this.history.length > this.config.maxHistory) {
      const excess = this.history.length - this.config.maxHistory;
      this.history = this.history.slice(excess);
      this.historyIndex -= excess;
    }

    this.pendingGroup = null;
  }

  /**
   * Apply a history entry's operations to current state
   * (For redo)
   */
  public applyForward(entry: HistoryEntry, state: EditorState): Transaction {
    let tr = state.tr;

    for (const op of entry.operations) {
      if (op.type === "insert") {
        tr = tr.insert(op.from, op.content);
      } else if (op.type === "delete") {
        tr = tr.delete(op.from, op.to);
      }
      // Retain operations don't need to be applied
    }

    return tr;
  }

  /**
   * Apply a history entry's inverse operations to current state
   * (For undo)
   */
  public applyBackward(entry: HistoryEntry, state: EditorState): Transaction {
    let tr = state.tr;

    for (const op of entry.inverseOperations) {
      if (op.type === "insert") {
        tr = tr.insert(op.from, op.content);
      } else if (op.type === "delete") {
        tr = tr.delete(op.from, op.to);
      }
      // Retain operations don't need to be applied
    }

    return tr;
  }

  /**
   * Export history for persistence
   */
  public export(): string {
    this.flushPendingGroup();
    return JSON.stringify({
      history: this.history.map((entry) => ({
        ...entry,
        // Convert ProseMirror nodes to JSON
        operations: entry.operations.map((op) => ({
          ...op,
          content:
            op.type !== "retain"
              ? op.content instanceof Fragment
                ? { type: "fragment", content: op.content.toJSON() }
                : { type: "node", content: op.content.toJSON() }
              : undefined,
        })),
        inverseOperations: entry.inverseOperations.map((op) => ({
          ...op,
          content:
            op.type !== "retain"
              ? op.content instanceof Fragment
                ? { type: "fragment", content: op.content.toJSON() }
                : { type: "node", content: op.content.toJSON() }
              : undefined,
        })),
      })),
      historyIndex: this.historyIndex,
    });
  }

  /**
   * Import history from persistence
   * Note: This is a simplified version - production would need proper schema handling
   */
  public import(data: string): void {
    try {
      const parsed = JSON.parse(data);
      // This would need proper reconstruction of ProseMirror nodes
      // For now, just restore the structure
      this.historyIndex = parsed.historyIndex || 0;
      // Full implementation would reconstruct nodes from JSON
    } catch (error) {
      console.error("Failed to import history:", error);
    }
  }
}
