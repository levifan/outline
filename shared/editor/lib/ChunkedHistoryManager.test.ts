import { describe, it, expect, beforeEach } from "vitest";
import { Schema, Node as ProsemirrorNode } from "prosemirror-model";
import { EditorState, Transaction } from "prosemirror-state";
import { ChunkedHistoryManager } from "./ChunkedHistoryManager";

describe("ChunkedHistoryManager", () => {
  let schema: Schema;
  let manager: ChunkedHistoryManager;
  let state: EditorState;

  beforeEach(() => {
    // Create a simple schema for testing
    schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "text*", group: "block" },
        text: {},
      },
    });

    // Create initial state
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Hello world")]),
    ]);

    state = EditorState.create({
      schema,
      doc,
    });

    manager = new ChunkedHistoryManager();
  });

  describe("Basic Operations", () => {
    it("should initialize with empty history", () => {
      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.currentIndex).toBe(0);
      expect(stats.canUndo).toBe(false);
      expect(stats.canRedo).toBe(false);
    });

    it("should record a transaction", () => {
      const tr = state.tr.insertText("!", 12);
      manager.recordTransaction(tr, "chunk-1", "user-123");

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(1);
      expect(stats.canUndo).toBe(true);
      expect(stats.canRedo).toBe(false);
    });

    it("should not record transactions without doc changes", () => {
      const tr = state.tr.setMeta("somePlugin", { data: "value" });
      manager.recordTransaction(tr, "chunk-1");

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
    });

    it("should not record transactions with addToHistory: false", () => {
      const tr = state.tr
        .insertText("!", 12)
        .setMeta("addToHistory", false);
      manager.recordTransaction(tr, "chunk-1");

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
    });
  });

  describe("Undo/Redo", () => {
    it("should undo a single change", () => {
      const tr = state.tr.insertText("!", 12);
      manager.recordTransaction(tr, "chunk-1");

      expect(manager.canUndo()).toBe(true);
      const entry = manager.undo();
      expect(entry).not.toBeNull();
      expect(entry?.chunkId).toBe("chunk-1");
      expect(manager.canUndo()).toBe(false);
    });

    it("should redo an undone change", () => {
      const tr = state.tr.insertText("!", 12);
      manager.recordTransaction(tr, "chunk-1");

      manager.undo();
      expect(manager.canRedo()).toBe(true);

      const entry = manager.redo();
      expect(entry).not.toBeNull();
      expect(manager.canRedo()).toBe(false);
    });

    it("should handle multiple undo/redo operations", () => {
      const tr1 = state.tr.insertText("!", 12);
      const state2 = state.apply(tr1);
      const tr2 = state2.tr.insertText("?", 13);
      const state3 = state2.apply(tr2);
      const tr3 = state3.tr.insertText(".", 14);

      manager.recordTransaction(tr1, "chunk-1");
      manager.recordTransaction(tr2, "chunk-1");
      manager.recordTransaction(tr3, "chunk-1");

      expect(manager.getStats().totalEntries).toBe(3);

      manager.undo();
      manager.undo();
      expect(manager.canUndo()).toBe(true);
      expect(manager.getStats().currentIndex).toBe(1);

      manager.redo();
      expect(manager.getStats().currentIndex).toBe(2);
    });

    it("should clear redo history after new change", () => {
      const tr1 = state.tr.insertText("!", 12);
      const state2 = state.apply(tr1);
      const tr2 = state2.tr.insertText("?", 13);

      manager.recordTransaction(tr1, "chunk-1");
      manager.recordTransaction(tr2, "chunk-1");
      manager.undo();

      expect(manager.canRedo()).toBe(true);

      // Make a new change - should clear redo stack
      const state3 = state2.tr.insertText(".", 13);
      manager.recordTransaction(state3, "chunk-1");

      expect(manager.canRedo()).toBe(false);
      expect(manager.getStats().totalEntries).toBe(2);
    });
  });

  describe("Change Grouping", () => {
    it("should group rapid consecutive changes", (done) => {
      const tr1 = state.tr.insertText("a", 12);
      const state2 = state.apply(tr1);
      const tr2 = state2.tr.insertText("b", 13);
      const state3 = state2.apply(tr2);
      const tr3 = state3.tr.insertText("c", 14);

      manager.recordTransaction(tr1, "chunk-1");

      // Record second change within grouping delay
      setTimeout(() => {
        manager.recordTransaction(tr2, "chunk-1");

        // Record third change within grouping delay
        setTimeout(() => {
          manager.recordTransaction(tr3, "chunk-1");

          // Should be grouped into one entry
          const stats = manager.getStats();
          expect(stats.totalEntries).toBe(1);

          done();
        }, 100); // Within default 500ms grouping delay
      }, 100);
    });

    it("should not group changes after delay", (done) => {
      const tr1 = state.tr.insertText("a", 12);
      const state2 = state.apply(tr1);
      const tr2 = state2.tr.insertText("b", 13);

      manager = new ChunkedHistoryManager({ groupingDelay: 200 });
      manager.recordTransaction(tr1, "chunk-1");

      // Wait longer than grouping delay
      setTimeout(() => {
        manager.recordTransaction(tr2, "chunk-1");

        const stats = manager.getStats();
        expect(stats.totalEntries).toBe(2);

        done();
      }, 300);
    });
  });

  describe("History Limits", () => {
    it("should enforce maximum history limit", () => {
      manager = new ChunkedHistoryManager({ maxHistory: 5 });

      // Add 10 changes
      let currentState = state;
      for (let i = 0; i < 10; i++) {
        const tr = currentState.tr.insertText(`${i}`, 1);
        currentState = currentState.apply(tr);
        manager.recordTransaction(tr, "chunk-1");

        // Wait to avoid grouping
        if (i < 9) {
          // Force flush by calling canUndo
          manager.canUndo();
        }
      }

      const stats = manager.getStats();
      expect(stats.totalEntries).toBeLessThanOrEqual(5);
    });

    it("should maintain correct index after limit enforcement", () => {
      manager = new ChunkedHistoryManager({ maxHistory: 3 });

      let currentState = state;
      for (let i = 0; i < 5; i++) {
        const tr = currentState.tr.insertText(`${i}`, 1);
        currentState = currentState.apply(tr);
        manager.recordTransaction(tr, "chunk-1");
        manager.canUndo(); // Force flush
      }

      expect(manager.canUndo()).toBe(true);
      manager.undo();
      expect(manager.canUndo()).toBe(true);
    });
  });

  describe("Memory Management", () => {
    it("should calculate memory usage", () => {
      const tr = state.tr.insertText("Hello", 12);
      manager.recordTransaction(tr, "chunk-1");

      const memoryUsage = manager.getMemoryUsage();
      expect(memoryUsage).toBeGreaterThan(0);
    });

    it("should reduce memory after clear", () => {
      const tr1 = state.tr.insertText("a", 12);
      const state2 = state.apply(tr1);
      const tr2 = state2.tr.insertText("b", 13);

      manager.recordTransaction(tr1, "chunk-1");
      manager.recordTransaction(tr2, "chunk-1");

      const beforeClear = manager.getMemoryUsage();
      manager.clear();
      const afterClear = manager.getMemoryUsage();

      expect(afterClear).toBe(0);
      expect(beforeClear).toBeGreaterThan(0);
    });
  });

  describe("Statistics", () => {
    it("should provide accurate statistics", () => {
      const tr = state.tr.insertText("!", 12);
      manager.recordTransaction(tr, "chunk-1");

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(1);
      expect(stats.currentIndex).toBe(1);
      expect(stats.canUndo).toBe(true);
      expect(stats.canRedo).toBe(false);
      expect(stats.memoryUsage).toBeGreaterThan(0);
      expect(stats.oldestEntry).toBeDefined();
      expect(stats.newestEntry).toBeDefined();
    });

    it("should update statistics after undo", () => {
      const tr = state.tr.insertText("!", 12);
      manager.recordTransaction(tr, "chunk-1");

      manager.undo();
      const stats = manager.getStats();

      expect(stats.currentIndex).toBe(0);
      expect(stats.canUndo).toBe(false);
      expect(stats.canRedo).toBe(true);
    });
  });

  describe("Clear", () => {
    it("should clear all history", () => {
      const tr = state.tr.insertText("!", 12);
      manager.recordTransaction(tr, "chunk-1");

      expect(manager.getStats().totalEntries).toBe(1);

      manager.clear();

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.currentIndex).toBe(0);
      expect(stats.canUndo).toBe(false);
      expect(stats.canRedo).toBe(false);
    });
  });

  describe("Cross-Chunk History", () => {
    it("should track changes across different chunks", () => {
      const tr1 = state.tr.insertText("a", 12);
      const state2 = state.apply(tr1);
      const tr2 = state2.tr.insertText("b", 13);

      manager.recordTransaction(tr1, "chunk-1");
      manager.canUndo(); // Force flush
      manager.recordTransaction(tr2, "chunk-2");

      expect(manager.getStats().totalEntries).toBe(2);

      const entry1 = manager.undo();
      expect(entry1?.chunkId).toBe("chunk-2");

      const entry2 = manager.undo();
      expect(entry2?.chunkId).toBe("chunk-1");
    });
  });

  describe("Configuration", () => {
    it("should respect custom max history", () => {
      manager = new ChunkedHistoryManager({ maxHistory: 2 });

      let currentState = state;
      for (let i = 0; i < 3; i++) {
        const tr = currentState.tr.insertText(`${i}`, 1);
        currentState = currentState.apply(tr);
        manager.recordTransaction(tr, "chunk-1");
        manager.canUndo(); // Force flush
      }

      expect(manager.getStats().totalEntries).toBe(2);
    });

    it("should respect compression setting", () => {
      const withCompression = new ChunkedHistoryManager({
        enableCompression: true,
      });
      const withoutCompression = new ChunkedHistoryManager({
        enableCompression: false,
      });

      const tr = state.tr.insertText("Hello", 12);

      withCompression.recordTransaction(tr, "chunk-1");
      withoutCompression.recordTransaction(tr, "chunk-1");

      // Both should work, compression is internal optimization
      expect(withCompression.canUndo()).toBe(true);
      expect(withoutCompression.canUndo()).toBe(true);
    });
  });

  describe("Apply Operations", () => {
    it("should apply forward operations for redo", () => {
      const tr = state.tr.insertText("!", 12);
      manager.recordTransaction(tr, "chunk-1");

      const entry = manager.undo();
      expect(entry).not.toBeNull();

      if (entry) {
        const redoTr = manager.applyForward(entry, state);
        expect(redoTr.doc.textContent).toContain("!");
      }
    });

    it("should apply backward operations for undo", () => {
      const tr = state.tr.insertText("!", 12);
      const newState = state.apply(tr);
      manager.recordTransaction(tr, "chunk-1");

      const entry = manager.undo();
      expect(entry).not.toBeNull();

      if (entry) {
        const undoTr = manager.applyBackward(entry, newState);
        expect(undoTr.doc.textContent).not.toContain("!");
      }
    });
  });
});
