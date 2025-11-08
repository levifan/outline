import { Node as ProsemirrorNode, Schema } from "prosemirror-model";
import {
  DocumentChunk,
  ChunkMetadata,
  ChunkingConfig,
} from "./DocumentChunk";
import { ChunkingStrategy } from "./ChunkingStrategy";
import { PerformanceMonitor } from "./PerformanceMonitor";

// Simple logger for shared code (avoid circular dependencies)
const Logger = {
  info: (message: string, category?: string) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`[${category || "ChunkManager"}] ${message}`);
    }
  },
  debug: (message: string, category?: string) => {
    if (process.env.NODE_ENV === "development") {
      console.debug(`[${category || "ChunkManager"}] ${message}`);
    }
  },
  warn: (message: string, category?: string) => {
    console.warn(`[${category || "ChunkManager"}] ${message}`);
  },
  error: (message: string, error?: any) => {
    console.error(`[ChunkManager] ${message}`, error);
  },
};

/**
 * Chunk 管理器
 * 负责文档分块、加载、卸载和内存管理
 */
export class ChunkManager {
  private chunks: Map<string, DocumentChunk> = new Map();
  private chunkOrder: string[] = []; // chunk ID 的有序数组
  private loadedChunks: Set<string> = new Set();
  private unloadTimer?: NodeJS.Timeout;
  private performanceMonitor: PerformanceMonitor;
  private monitoringInterval?: NodeJS.Timer;

  constructor(
    private schema: Schema,
    private config: ChunkingConfig,
    private onChunkLoad: (chunk: DocumentChunk) => void,
    private onChunkUnload: (chunkId: string) => void
  ) {
    this.performanceMonitor = new PerformanceMonitor();

    // 启动性能监控（如果启用）
    if (this.config.monitoring.enabled) {
      this.startMonitoring();
    }
  }

  /**
   * 初始化：将完整文档拆分为 chunks
   */
  public initialize(doc: ProsemirrorNode) {
    PerformanceMonitor.mark("chunk-init-start");

    const strategy = new ChunkingStrategy(this.config, this.schema);
    const chunks = strategy.chunkDocument(doc);

    Logger.info(
      `ChunkManager: Initialized with ${chunks.length} chunks`,
      "chunking"
    );

    chunks.forEach((chunk) => {
      this.chunks.set(chunk.metadata.id, chunk);
      this.chunkOrder.push(chunk.metadata.id);
    });

    PerformanceMonitor.mark("chunk-init-end");
    PerformanceMonitor.measureBetween(
      "chunk-initialization",
      "chunk-init-start",
      "chunk-init-end"
    );

    // 初始加载第一个 chunk
    if (chunks.length > 0) {
      void this.loadChunkByIndex(0);
    }
  }

  /**
   * 根据滚动位置加载/卸载 chunks
   */
  public handleScroll(scrollTop: number) {
    const activeChunkIndex = this.getChunkIndexAtScrollPosition(scrollTop);

    if (activeChunkIndex === -1) {
      return;
    }

    // 计算需要加载的 chunk 范围
    const { overscanCount } = this.config.virtualScroll;
    const startIndex = Math.max(0, activeChunkIndex - overscanCount);
    const endIndex = Math.min(
      this.chunkOrder.length - 1,
      activeChunkIndex + overscanCount
    );

    // 加载范围内的 chunks
    for (let i = startIndex; i <= endIndex; i++) {
      void this.loadChunkByIndex(i);
    }

    // 卸载范围外的 chunks (延迟执行)
    this.scheduleUnloadOutOfRangeChunks(startIndex, endIndex);
  }

  /**
   * 加载指定索引的 chunk
   */
  public async loadChunkByIndex(index: number): Promise<void> {
    if (index < 0 || index >= this.chunkOrder.length) {
      return;
    }

    const chunkId = this.chunkOrder[index];
    return this.loadChunk(chunkId);
  }

  /**
   * 加载指定 chunk
   */
  public async loadChunk(chunkId: string): Promise<void> {
    const chunk = this.chunks.get(chunkId);

    if (!chunk) {
      Logger.warn(`ChunkManager: Chunk ${chunkId} not found`, "chunking");
      return;
    }

    // 已经加载或正在加载
    if (
      this.loadedChunks.has(chunkId) ||
      chunk.metadata.loadState === "loading"
    ) {
      return;
    }

    chunk.metadata.loadState = "loading";

    try {
      const loadStartTime = performance.now();

      // 从 rawData 创建 ProseMirror 节点
      if (chunk.rawData) {
        chunk.content = ProsemirrorNode.fromJSON(this.schema, chunk.rawData);
      }

      const loadDuration = performance.now() - loadStartTime;
      this.performanceMonitor.recordLoadTime(loadDuration);

      chunk.metadata.loadState = "loaded";
      this.loadedChunks.add(chunkId);

      // 触发回调
      this.onChunkLoad(chunk);

      Logger.debug(
        `ChunkManager: Chunk ${chunkId} loaded in ${loadDuration.toFixed(2)}ms`,
        "chunking"
      );
    } catch (error) {
      chunk.metadata.loadState = "unloaded";
      Logger.error(`ChunkManager: Failed to load chunk ${chunkId}`, error);
      throw error;
    }
  }

  /**
   * 卸载 chunk（释放内存）
   */
  public unloadChunk(chunkId: string) {
    const chunk = this.chunks.get(chunkId);

    if (!chunk || !this.loadedChunks.has(chunkId)) {
      return;
    }

    chunk.metadata.loadState = "unloading";

    // 释放 ProseMirror 节点内容
    delete chunk.content;

    chunk.metadata.loadState = "unloaded";
    this.loadedChunks.delete(chunkId);

    // 触发回调
    this.onChunkUnload(chunkId);

    Logger.debug(`ChunkManager: Chunk ${chunkId} unloaded`, "chunking");
  }

  /**
   * 计划卸载范围外的 chunks
   */
  private scheduleUnloadOutOfRangeChunks(startIndex: number, endIndex: number) {
    // 清除旧的卸载计划
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
    }

    // 延迟执行（用户可能返回）
    this.unloadTimer = setTimeout(() => {
      this.chunkOrder.forEach((chunkId, index) => {
        // 保留前后各1个chunk（避免边界闪烁）
        if (index < startIndex - 1 || index > endIndex + 1) {
          this.unloadChunk(chunkId);
        }
      });
    }, this.config.virtualScroll.unloadDelay);
  }

  /**
   * 根据滚动位置计算当前 chunk 索引
   */
  private getChunkIndexAtScrollPosition(scrollTop: number): number {
    let accumulatedHeight = 0;

    for (let i = 0; i < this.chunkOrder.length; i++) {
      const chunk = this.chunks.get(this.chunkOrder[i])!;
      const height =
        chunk.metadata.actualHeight ?? chunk.metadata.estimatedHeight;

      if (scrollTop < accumulatedHeight + height) {
        return i;
      }

      accumulatedHeight += height;
    }

    return this.chunkOrder.length - 1;
  }

  /**
   * 获取所有 chunk 的元数据（用于 TOC）
   */
  public getAllChunkMetadata(): ChunkMetadata[] {
    return this.chunkOrder.map((id) => this.chunks.get(id)!.metadata);
  }

  /**
   * 获取指定 chunk
   */
  public getChunk(chunkId: string): DocumentChunk | undefined {
    return this.chunks.get(chunkId);
  }

  /**
   * 根据 heading ID 查找对应的 chunk
   */
  public findChunkByHeadingId(headingId: string): DocumentChunk | undefined {
    for (const [, chunk] of this.chunks) {
      if (chunk.metadata.headings.some((h) => h.id === headingId)) {
        return chunk;
      }
    }
    return undefined;
  }

  /**
   * 更新 chunk 的实际高度
   */
  public updateChunkHeight(chunkId: string, height: number) {
    const chunk = this.chunks.get(chunkId);
    if (chunk) {
      chunk.metadata.actualHeight = height;
    }
  }

  /**
   * 获取文档的总高度
   */
  public getTotalHeight(): number {
    return this.getAllChunkMetadata().reduce(
      (sum, metadata) =>
        sum + (metadata.actualHeight ?? metadata.estimatedHeight),
      0
    );
  }

  /**
   * 获取已加载的 chunks
   */
  public getLoadedChunks(): DocumentChunk[] {
    return Array.from(this.loadedChunks)
      .map((id) => this.chunks.get(id))
      .filter((chunk): chunk is DocumentChunk => chunk !== undefined);
  }

  /**
   * 检查 chunk 是否已加载
   */
  public isChunkLoaded(chunkId: string): boolean {
    return this.loadedChunks.has(chunkId);
  }

  /**
   * 根据全局位置查找对应的 chunk
   */
  public findChunkByPosition(pos: number): DocumentChunk | undefined {
    for (const [, chunk] of this.chunks) {
      if (pos >= chunk.metadata.startPos && pos <= chunk.metadata.endPos) {
        return chunk;
      }
    }
    return undefined;
  }

  /**
   * 预加载指定范围的 chunks
   */
  public async preloadChunks(startIndex: number, endIndex: number) {
    const promises: Promise<void>[] = [];

    for (let i = startIndex; i <= endIndex; i++) {
      if (i >= 0 && i < this.chunkOrder.length) {
        promises.push(this.loadChunkByIndex(i));
      }
    }

    await Promise.all(promises);
  }

  /**
   * 启动性能监控
   */
  private startMonitoring() {
    this.monitoringInterval = PerformanceMonitor.createMonitoringInterval(
      this,
      this.config.monitoring.logInterval
    );
  }

  /**
   * 停止性能监控
   */
  private stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  /**
   * 清理资源
   */
  public destroy() {
    // 清除计时器
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
    }

    this.stopMonitoring();

    // 卸载所有 chunks
    this.chunkOrder.forEach((chunkId) => {
      this.unloadChunk(chunkId);
    });

    // 清空数据
    this.chunks.clear();
    this.chunkOrder = [];
    this.loadedChunks.clear();

    Logger.info("ChunkManager: Destroyed", "chunking");
  }

  /**
   * 获取性能指标
   */
  public getPerformanceMetrics() {
    return this.performanceMonitor.getMetrics(this);
  }

  /**
   * 打印性能统计
   */
  public logPerformanceStats() {
    this.performanceMonitor.logChunkStats(this);
  }

  /**
   * 打印详细信息
   */
  public logDetailedInfo() {
    this.performanceMonitor.logDetailedChunkInfo(this);
  }
}
