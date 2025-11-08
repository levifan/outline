import { ChunkManager } from "./ChunkManager";

/**
 * 性能指标
 */
export interface PerformanceMetrics {
  /** 已加载的 chunk 数量 */
  loadedChunks: number;
  /** 总 chunk 数量 */
  totalChunks: number;
  /** 内存使用量 (MB) */
  memoryUsage: number;
  /** 加载比例 (0-1) */
  loadRatio: number;
  /** 平均 chunk 加载时间 (ms) */
  avgLoadTime: number;
  /** 最后测量时间 */
  timestamp: number;
}

/**
 * 性能监控器
 */
export class PerformanceMonitor {
  private loadTimes: number[] = [];
  private maxLoadTimeRecords = 50;

  /**
   * 测量函数执行时间
   */
  public static measure(label: string, fn: () => void): number {
    const start = performance.now();
    fn();
    const duration = performance.now() - start;

    if (process.env.NODE_ENV === "development") {
      console.log(`⏱️  ${label}: ${duration.toFixed(2)}ms`);
    }

    return duration;
  }

  /**
   * 测量异步函数执行时间
   */
  public static async measureAsync(
    label: string,
    fn: () => Promise<void>
  ): Promise<number> {
    const start = performance.now();
    await fn();
    const duration = performance.now() - start;

    if (process.env.NODE_ENV === "development") {
      console.log(`⏱️  ${label}: ${duration.toFixed(2)}ms`);
    }

    return duration;
  }

  /**
   * 测量内存使用量
   */
  public static measureMemory(): number {
    if ("memory" in performance) {
      const memory = (performance as any).memory;
      return memory.usedJSHeapSize / 1024 / 1024; // Convert to MB
    }
    return 0;
  }

  /**
   * 记录 chunk 加载时间
   */
  public recordLoadTime(duration: number) {
    this.loadTimes.push(duration);

    // 限制记录数量
    if (this.loadTimes.length > this.maxLoadTimeRecords) {
      this.loadTimes.shift();
    }
  }

  /**
   * 获取平均加载时间
   */
  public getAverageLoadTime(): number {
    if (this.loadTimes.length === 0) {
      return 0;
    }

    const sum = this.loadTimes.reduce((acc, time) => acc + time, 0);
    return sum / this.loadTimes.length;
  }

  /**
   * 获取 ChunkManager 的性能指标
   */
  public getMetrics(chunkManager: ChunkManager): PerformanceMetrics {
    const metadata = chunkManager.getAllChunkMetadata();
    const loadedCount = metadata.filter((m) => m.loadState === "loaded").length;

    return {
      loadedChunks: loadedCount,
      totalChunks: metadata.length,
      memoryUsage: PerformanceMonitor.measureMemory(),
      loadRatio: metadata.length > 0 ? loadedCount / metadata.length : 0,
      avgLoadTime: this.getAverageLoadTime(),
      timestamp: Date.now(),
    };
  }

  /**
   * 打印 chunk 统计信息
   */
  public logChunkStats(chunkManager: ChunkManager) {
    const metrics = this.getMetrics(chunkManager);

    console.group("📊 Chunk Performance Stats");
    console.table({
      "Total Chunks": metrics.totalChunks,
      "Loaded Chunks": metrics.loadedChunks,
      "Memory (MB)": metrics.memoryUsage.toFixed(2),
      "Load Ratio": `${(metrics.loadRatio * 100).toFixed(1)}%`,
      "Avg Load Time (ms)": metrics.avgLoadTime.toFixed(2),
    });
    console.groupEnd();
  }

  /**
   * 打印详细的 chunk 列表
   */
  public logDetailedChunkInfo(chunkManager: ChunkManager) {
    const metadata = chunkManager.getAllChunkMetadata();

    console.group("📋 Detailed Chunk Information");
    metadata.forEach((chunk) => {
      console.log(
        `${chunk.id}: ${chunk.loadState} | ` +
          `Nodes: ${chunk.nodeCount} | ` +
          `Height: ${chunk.actualHeight ?? chunk.estimatedHeight}px | ` +
          `Headings: ${chunk.headings.length}`
      );
    });
    console.groupEnd();
  }

  /**
   * 创建性能监控间隔器
   */
  public static createMonitoringInterval(
    chunkManager: ChunkManager,
    interval: number
  ): NodeJS.Timer {
    const monitor = new PerformanceMonitor();

    return setInterval(() => {
      monitor.logChunkStats(chunkManager);
    }, interval);
  }

  /**
   * 记录性能标记
   */
  public static mark(name: string) {
    if (performance.mark) {
      performance.mark(name);
    }
  }

  /**
   * 测量两个标记之间的时间
   */
  public static measureBetween(name: string, startMark: string, endMark: string) {
    if (performance.measure) {
      try {
        performance.measure(name, startMark, endMark);
        const measure = performance.getEntriesByName(name)[0];
        if (measure && process.env.NODE_ENV === "development") {
          console.log(`⏱️  ${name}: ${measure.duration.toFixed(2)}ms`);
        }
      } catch (error) {
        // Marks don't exist, ignore
      }
    }
  }
}
