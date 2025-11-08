import { Schema } from "prosemirror-model";
import { ChunkingStrategy } from "./ChunkingStrategy";
import { DEFAULT_CHUNKING_CONFIG } from "./DocumentChunk";
import { schema as basicSchema } from "@shared/editor/nodes";

describe("ChunkingStrategy", () => {
  let schema: Schema;
  let strategy: ChunkingStrategy;

  beforeEach(() => {
    schema = new Schema({
      nodes: basicSchema.spec.nodes,
      marks: basicSchema.spec.marks,
    });

    strategy = new ChunkingStrategy(DEFAULT_CHUNKING_CONFIG, schema);
  });

  describe("chunkDocument", () => {
    it("should split document into chunks at heading boundaries", () => {
      // Create a document with multiple headings
      const doc = schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Chapter 1" }] },
          { type: "paragraph", content: [{ type: "text", text: "Paragraph 1" }] },
          { type: "paragraph", content: [{ type: "text", text: "Paragraph 2" }] },
          { type: "paragraph", content: [{ type: "text", text: "Paragraph 3" }] },
          { type: "paragraph", content: [{ type: "text", text: "Paragraph 4" }] },
          { type: "paragraph", content: [{ type: "text", text: "Paragraph 5" }] },
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Chapter 2" }] },
          { type: "paragraph", content: [{ type: "text", text: "Paragraph 6" }] },
          { type: "paragraph", content: [{ type: "text", text: "Paragraph 7" }] },
        ],
      });

      const chunks = strategy.chunkDocument(doc);

      // Should create at least 2 chunks (split at heading boundary)
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].metadata.index).toBe(0);
      expect(chunks[0].metadata.nodeCount).toBeGreaterThan(0);
    });

    it("should extract heading metadata from chunks", () => {
      const doc = schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Introduction" }] },
          { type: "paragraph", content: [{ type: "text", text: "Some text" }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Subsection" }] },
          { type: "paragraph", content: [{ type: "text", text: "More text" }] },
        ],
      });

      const chunks = strategy.chunkDocument(doc);

      // Find chunk with headings
      const chunkWithHeadings = chunks.find(c => c.metadata.headings.length > 0);
      expect(chunkWithHeadings).toBeDefined();

      if (chunkWithHeadings) {
        const headings = chunkWithHeadings.metadata.headings;
        expect(headings.length).toBeGreaterThan(0);
        expect(headings[0]).toHaveProperty("id");
        expect(headings[0]).toHaveProperty("title");
        expect(headings[0]).toHaveProperty("level");
      }
    });

    it("should respect minimum chunk size", () => {
      const doc = schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "P1" }] },
          { type: "paragraph", content: [{ type: "text", text: "P2" }] },
          { type: "paragraph", content: [{ type: "text", text: "P3" }] },
        ],
      });

      const chunks = strategy.chunkDocument(doc);

      // With only 3 nodes and minChunkSize=5, should create single chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.nodeCount).toBe(3);
    });

    it("should generate unique chunk IDs", () => {
      const doc = schema.nodeFromJSON({
        type: "doc",
        content: Array(30)
          .fill(null)
          .map((_, i) => ({
            type: "paragraph",
            content: [{ type: "text", text: `Paragraph ${i}` }],
          })),
      });

      const chunks = strategy.chunkDocument(doc);

      const ids = chunks.map((c) => c.metadata.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(chunks.length);
    });

    it("should estimate chunk height", () => {
      const doc = schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
          { type: "paragraph", content: [{ type: "text", text: "Short text" }] },
        ],
      });

      const chunks = strategy.chunkDocument(doc);

      expect(chunks[0].metadata.estimatedHeight).toBeGreaterThan(0);
    });
  });

  describe("shouldEnableChunking", () => {
    it("should enable chunking for large documents", () => {
      const largeDoc = schema.nodeFromJSON({
        type: "doc",
        content: Array(1100)
          .fill(null)
          .map(() => ({
            type: "paragraph",
            content: [{ type: "text", text: "Test" }],
          })),
      });

      const config = { ...DEFAULT_CHUNKING_CONFIG, enabled: true };
      const shouldEnable = ChunkingStrategy.shouldEnableChunking(largeDoc, config);

      expect(shouldEnable).toBe(true);
    });

    it("should not enable chunking for small documents", () => {
      const smallDoc = schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Small document" }] },
        ],
      });

      const config = { ...DEFAULT_CHUNKING_CONFIG, enabled: true };
      const shouldEnable = ChunkingStrategy.shouldEnableChunking(smallDoc, config);

      expect(shouldEnable).toBe(false);
    });

    it("should respect enabled flag", () => {
      const largeDoc = schema.nodeFromJSON({
        type: "doc",
        content: Array(1100)
          .fill(null)
          .map(() => ({
            type: "paragraph",
            content: [{ type: "text", text: "Test" }],
          })),
      });

      const config = { ...DEFAULT_CHUNKING_CONFIG, enabled: false };
      const shouldEnable = ChunkingStrategy.shouldEnableChunking(largeDoc, config);

      expect(shouldEnable).toBe(false);
    });
  });

  describe("estimateNodeCount", () => {
    it("should estimate node count from markdown string", () => {
      const markdown = `# Title\n\nParagraph 1\n\nParagraph 2\n\n## Subsection\n\nParagraph 3`;
      const count = ChunkingStrategy.estimateNodeCount(markdown);

      expect(count).toBeGreaterThan(0);
    });

    it("should count nodes from JSON data", () => {
      const json = {
        type: "doc",
        content: [
          { type: "paragraph" },
          { type: "paragraph" },
          { type: "paragraph" },
        ],
      };

      const count = ChunkingStrategy.estimateNodeCount(json);

      expect(count).toBe(3);
    });

    it("should return 0 for empty document", () => {
      const json = {
        type: "doc",
        content: [],
      };

      const count = ChunkingStrategy.estimateNodeCount(json);

      expect(count).toBe(0);
    });
  });
});
