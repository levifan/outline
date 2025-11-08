import { Node as ProsemirrorNode } from "prosemirror-model";
import { ProsemirrorData } from "@shared/types";

/**
 * Chunk 元数据
 */
export interface ChunkMetadata {
  /** 唯一标识符 */
  id: string;
  /** 块索引 (0-based) */
  index: number;
  /** 块内第一个节点的全局位置 */
  startPos: number;
  /** 块内最后一个节点的全局位置 */
  endPos: number;
  /** 块的估计高度 (px) */
  estimatedHeight: number;
  /** 块的实际高度 (渲染后) */
  actualHeight?: number;
  /** 加载状态 */
  loadState: "unloaded" | "loading" | "loaded" | "unloading";
  /** 块内包含的 heading 元数据 */
  headings: HeadingMetadata[];
  /** 块的内容哈希 (用于变更检测) */
  contentHash: string;
  /** 节点数量 */
  nodeCount: number;
}

/**
 * Heading 元数据
 */
export interface HeadingMetadata {
  /** Heading ID (slug) */
  id: string;
  /** 标题文本 */
  title: string;
  /** 标题级别 (1-6) */
  level: number;
  /** 在 chunk 内的相对位置 */
  relativePos: number;
}

/**
 * 文档块
 */
export interface DocumentChunk {
  /** 元数据 */
  metadata: ChunkMetadata;
  /** ProseMirror 节点内容 (仅在加载时存在) */
  content?: ProsemirrorNode;
  /** 原始 JSON 数据 (用于快速重载) */
  rawData?: ProsemirrorData;
}

/**
 * 分块配置
 */
export interface ChunkingConfig {
  /** 是否启用分块模式 */
  enabled: boolean;

  /** 自动启用阈值 */
  autoEnableThreshold: {
    /** 节点数量阈值 */
    nodeCount: number;
    /** 内容大小阈值 (bytes) */
    contentSize: number;
  };

  /** 分块参数 */
  chunking: {
    /** 目标块大小（节点数） */
    targetChunkSize: number;
    /** 最小块大小 */
    minChunkSize: number;
    /** 最大块大小 */
    maxChunkSize: number;
  };

  /** 虚拟滚动参数 */
  virtualScroll: {
    /** 预加载数量（前后各几个chunk） */
    overscanCount: number;
    /** 最大已加载 chunk 数量 */
    maxLoadedChunks: number;
    /** 卸载延迟 (ms) */
    unloadDelay: number;
  };

  /** 性能监控 */
  monitoring: {
    /** 是否启用 */
    enabled: boolean;
    /** 日志间隔 (ms) */
    logInterval: number;
  };
}

/**
 * 默认配置
 */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  enabled: false,
  autoEnableThreshold: {
    nodeCount: 1000,
    contentSize: 500 * 1024, // 500KB
  },
  chunking: {
    targetChunkSize: 10,
    minChunkSize: 5,
    maxChunkSize: 20,
  },
  virtualScroll: {
    overscanCount: 2,
    maxLoadedChunks: 7,
    unloadDelay: 5000,
  },
  monitoring: {
    enabled: process.env.NODE_ENV === "development",
    logInterval: 10000,
  },
};
