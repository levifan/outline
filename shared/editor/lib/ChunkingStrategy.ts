import { Node as ProsemirrorNode, Schema } from "prosemirror-model";
import { ProsemirrorData } from "@shared/types";
import headingToSlug from "@shared/editor/lib/headingToSlug";
import {
  DocumentChunk,
  ChunkMetadata,
  HeadingMetadata,
  ChunkingConfig,
} from "./DocumentChunk";

/**
 * 文档分块策略
 */
export class ChunkingStrategy {
  constructor(
    private config: ChunkingConfig,
    private schema: Schema
  ) {}

  /**
   * 将完整文档拆分为多个 chunk
   */
  public chunkDocument(doc: ProsemirrorNode): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const nodes: ProsemirrorNode[] = [];

    // 收集所有顶层节点
    doc.forEach((node) => {
      nodes.push(node);
    });

    if (nodes.length === 0) {
      return [];
    }

    let currentChunkNodes: ProsemirrorNode[] = [];
    let currentStartPos = 0;
    let chunkIndex = 0;

    nodes.forEach((node, index) => {
      currentChunkNodes.push(node);

      // 判断是否需要结束当前 chunk
      const shouldSplit = this.shouldSplitChunk(
        currentChunkNodes,
        node,
        index,
        nodes.length
      );

      if (shouldSplit) {
        const endPos = this.calculateEndPos(currentChunkNodes, currentStartPos);
        chunks.push(
          this.createChunk(chunkIndex++, currentChunkNodes, currentStartPos, endPos)
        );
        currentStartPos = endPos;
        currentChunkNodes = [];
      }
    });

    // 处理剩余节点
    if (currentChunkNodes.length > 0) {
      const endPos = this.calculateEndPos(currentChunkNodes, currentStartPos);
      chunks.push(
        this.createChunk(chunkIndex, currentChunkNodes, currentStartPos, endPos)
      );
    }

    return chunks;
  }

  /**
   * 判断是否应该拆分 chunk
   */
  private shouldSplitChunk(
    nodes: ProsemirrorNode[],
    currentNode: ProsemirrorNode,
    index: number,
    totalNodes: number
  ): boolean {
    const nodeCount = nodes.length;
    const { targetChunkSize, minChunkSize, maxChunkSize } = this.config.chunking;

    // 未达到最小大小，不拆分
    if (nodeCount < minChunkSize) {
      return false;
    }

    // 超过最大大小，强制拆分
    if (nodeCount >= maxChunkSize) {
      return true;
    }

    // 达到目标大小 + 当前是 heading → 在 heading 之前拆分
    if (nodeCount >= targetChunkSize && currentNode.type.name === "heading") {
      return true;
    }

    // 最后一个节点，不拆分
    if (index === totalNodes - 1) {
      return false;
    }

    return false;
  }

  /**
   * 计算 chunk 的结束位置
   */
  private calculateEndPos(
    nodes: ProsemirrorNode[],
    startPos: number
  ): number {
    let endPos = startPos;
    nodes.forEach((node) => {
      endPos += node.nodeSize;
    });
    return endPos;
  }

  /**
   * 创建 chunk
   */
  private createChunk(
    index: number,
    nodes: ProsemirrorNode[],
    startPos: number,
    endPos: number
  ): DocumentChunk {
    const headings = this.extractHeadings(nodes);
    const estimatedHeight = this.estimateHeight(nodes);
    const rawData = this.nodesToJSON(nodes);
    const contentHash = this.hashContent(rawData);

    return {
      metadata: {
        id: `chunk-${index}`,
        index,
        startPos,
        endPos,
        estimatedHeight,
        loadState: "unloaded",
        headings,
        contentHash,
        nodeCount: nodes.length,
      },
      rawData,
    };
  }

  /**
   * 提取 chunk 内的 heading 元数据
   */
  private extractHeadings(nodes: ProsemirrorNode[]): HeadingMetadata[] {
    const headings: HeadingMetadata[] = [];
    let pos = 0;

    nodes.forEach((node) => {
      if (node.type.name === "heading") {
        const slug = headingToSlug(node);
        headings.push({
          id: slug,
          title: node.textContent,
          level: node.attrs.level as number,
          relativePos: pos,
        });
      }
      pos += node.nodeSize;
    });

    return headings;
  }

  /**
   * 估计 chunk 高度 (用于虚拟滚动)
   */
  private estimateHeight(nodes: ProsemirrorNode[]): number {
    let totalHeight = 0;

    nodes.forEach((node) => {
      totalHeight += this.estimateNodeHeight(node);
    });

    return totalHeight;
  }

  /**
   * 估计单个节点的高度
   */
  private estimateNodeHeight(node: ProsemirrorNode): number {
    switch (node.type.name) {
      case "heading":
        // 根据级别估算高度
        const level = node.attrs.level as number;
        if (level === 1) return 60;
        if (level === 2) return 48;
        return 40;

      case "paragraph":
        // 根据文本长度估算行数
        const lineCount = Math.max(1, Math.ceil(node.textContent.length / 80));
        return lineCount * 24 + 8; // 行高24px + 间距8px

      case "code_block":
        const codeLines = node.textContent.split("\n").length;
        return codeLines * 20 + 30; // 代码行高20px + 内边距30px

      case "image":
      case "video":
        return 300;

      case "table":
        return 200;

      case "bullet_list":
      case "ordered_list":
        // 估算列表项数量
        let itemCount = 0;
        node.forEach(() => itemCount++);
        return itemCount * 30;

      case "checkbox_list":
        let checkboxCount = 0;
        node.forEach(() => checkboxCount++);
        return checkboxCount * 32;

      case "blockquote":
        return this.estimateHeight([node.content.child(0)]) + 20;

      case "horizontal_rule":
        return 24;

      default:
        return 30;
    }
  }

  /**
   * 将节点数组转换为 JSON
   */
  private nodesToJSON(nodes: ProsemirrorNode[]): ProsemirrorData {
    return {
      type: "doc",
      content: nodes.map((n) => n.toJSON()),
    };
  }

  /**
   * 计算内容哈希 (用于变更检测)
   */
  private hashContent(data: ProsemirrorData): string {
    const str = JSON.stringify(data);
    let hash = 0;

    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    return hash.toString(36);
  }

  /**
   * 检查是否应该启用分块模式
   */
  public static shouldEnableChunking(
    doc: ProsemirrorNode,
    config: ChunkingConfig
  ): boolean {
    if (!config.enabled) {
      return false;
    }

    // 计算节点数量
    let nodeCount = 0;
    doc.forEach(() => nodeCount++);

    // 检查是否超过阈值
    if (nodeCount >= config.autoEnableThreshold.nodeCount) {
      return true;
    }

    // 检查文档大小
    const docSize = JSON.stringify(doc.toJSON()).length;
    if (docSize >= config.autoEnableThreshold.contentSize) {
      return true;
    }

    return false;
  }

  /**
   * 估算文档的节点数量（从 JSON 数据）
   */
  public static estimateNodeCount(data: string | object): number {
    let json: any;

    if (typeof data === "string") {
      // Markdown 文本：估算段落数
      const lines = data.split("\n");
      return lines.filter((line) => line.trim().length > 0).length;
    } else {
      json = data;
    }

    if (!json.content || !Array.isArray(json.content)) {
      return 0;
    }

    return json.content.length;
  }
}
