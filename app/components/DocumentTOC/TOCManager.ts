import { ChunkManager } from "@shared/editor/lib/ChunkManager";
import { HeadingMetadata } from "@shared/editor/lib/DocumentChunk";

/**
 * Heading 位置信息
 */
export interface HeadingLocation extends HeadingMetadata {
  /** 所在的 chunk ID */
  chunkId: string;
  /** 所在 chunk 的索引 */
  chunkIndex: number;
  /** 是否已加载 */
  isLoaded: boolean;
}

/**
 * TOC 管理器
 * 负责管理全局 heading 元数据和跨页导航
 */
export class TOCManager {
  private allHeadings: Map<string, HeadingLocation> = new Map();
  private updateCallbacks: Set<() => void> = new Set();

  constructor(private chunkManager: ChunkManager) {
    this.initializeFromChunks();
  }

  /**
   * 从所有 chunk 元数据初始化 TOC
   */
  private initializeFromChunks() {
    const metadata = this.chunkManager.getAllChunkMetadata();

    metadata.forEach((chunk) => {
      chunk.headings.forEach((heading) => {
        this.allHeadings.set(heading.id, {
          ...heading,
          chunkId: chunk.id,
          chunkIndex: chunk.index,
          isLoaded: chunk.loadState === "loaded",
        });
      });
    });
  }

  /**
   * 更新特定 chunk 的 headings
   */
  public updateChunkHeadings(chunkId: string, newHeadings: HeadingMetadata[]) {
    // 1. 删除旧的 headings
    Array.from(this.allHeadings.values())
      .filter((h) => h.chunkId === chunkId)
      .forEach((h) => this.allHeadings.delete(h.id));

    // 2. 添加新的 headings
    const chunk = this.chunkManager.getChunk(chunkId);
    if (chunk) {
      newHeadings.forEach((heading) => {
        this.allHeadings.set(heading.id, {
          ...heading,
          chunkId,
          chunkIndex: chunk.metadata.index,
          isLoaded: chunk.metadata.loadState === "loaded",
        });
      });
    }

    // 3. 触发更新回调
    this.notifyUpdate();
  }

  /**
   * 跳转到指定 heading（跨页）
   */
  public async scrollToHeading(headingId: string): Promise<void> {
    const location = this.allHeadings.get(headingId);

    if (!location) {
      console.warn(`TOCManager: Heading "${headingId}" not found`);
      return;
    }

    try {
      // 1. 确保目标 chunk 已加载
      if (!location.isLoaded) {
        console.log(
          `TOCManager: Loading chunk ${location.chunkId} for heading "${headingId}"...`
        );
        await this.loadChunkForHeading(location);
      }

      // 2. 等待 DOM 渲染
      await this.waitForElement(`#${headingId}`, 3000);

      // 3. 滚动到目标元素
      const element = document.getElementById(headingId);
      if (element) {
        element.scrollIntoView({
          behavior: "smooth",
          block: "start",
          inline: "nearest",
        });

        // 4. 高亮动画（可选）
        this.highlightElement(element);
      } else {
        console.warn(
          `TOCManager: Element #${headingId} not found after loading`
        );
      }
    } catch (error) {
      console.error(`TOCManager: Failed to scroll to heading "${headingId}"`, error);
      throw error;
    }
  }

  /**
   * 为 heading 加载所需的 chunk
   */
  private async loadChunkForHeading(location: HeadingLocation): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(`Timeout: Failed to load chunk ${location.chunkId}`)
        );
      }, 5000);

      // 触发加载
      void this.chunkManager.loadChunkByIndex(location.chunkIndex);

      // 轮询检查是否加载完成
      const checkInterval = setInterval(() => {
        const chunk = this.chunkManager.getChunk(location.chunkId);

        if (chunk?.metadata.loadState === "loaded") {
          clearInterval(checkInterval);
          clearTimeout(timeout);

          // 更新 heading 的 isLoaded 状态
          location.isLoaded = true;

          resolve();
        }
      }, 100);
    });
  }

  /**
   * 等待元素出现在 DOM 中
   */
  private waitForElement(selector: string, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // 先检查是否已存在
      if (document.querySelector(selector)) {
        resolve();
        return;
      }

      // 监听 DOM 变化
      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) {
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // 超时保护
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout: Element ${selector} not found after ${timeout}ms`));
      }, timeout);
    });
  }

  /**
   * 高亮元素（动画效果）
   */
  private highlightElement(element: HTMLElement) {
    const originalBackground = element.style.backgroundColor;

    // 添加高亮
    element.style.transition = "background-color 0.3s ease";
    element.style.backgroundColor = "rgba(255, 215, 0, 0.3)"; // 金色高亮

    // 2秒后移除高亮
    setTimeout(() => {
      element.style.backgroundColor = originalBackground;
      setTimeout(() => {
        element.style.transition = "";
      }, 300);
    }, 2000);
  }

  /**
   * 获取所有 heading（用于渲染 TOC）
   */
  public getAllHeadings(): HeadingLocation[] {
    return Array.from(this.allHeadings.values()).sort(
      (a, b) => a.chunkIndex - b.chunkIndex || a.relativePos - b.relativePos
    );
  }

  /**
   * 获取已加载的 headings
   */
  public getLoadedHeadings(): HeadingLocation[] {
    return this.getAllHeadings().filter((h) => h.isLoaded);
  }

  /**
   * 根据 ID 获取 heading
   */
  public getHeading(headingId: string): HeadingLocation | undefined {
    return this.allHeadings.get(headingId);
  }

  /**
   * 更新 heading 的加载状态
   */
  public updateHeadingLoadState(chunkId: string, isLoaded: boolean) {
    Array.from(this.allHeadings.values())
      .filter((h) => h.chunkId === chunkId)
      .forEach((h) => {
        h.isLoaded = isLoaded;
      });

    this.notifyUpdate();
  }

  /**
   * 注册更新回调
   */
  public onUpdate(callback: () => void) {
    this.updateCallbacks.add(callback);
    return () => this.updateCallbacks.delete(callback);
  }

  /**
   * 触发更新通知
   */
  private notifyUpdate() {
    this.updateCallbacks.forEach((callback) => callback());
  }

  /**
   * 预加载相邻 chunks（优化体验）
   */
  public async preloadAdjacentChunks(headingId: string) {
    const location = this.allHeadings.get(headingId);
    if (!location) return;

    const { chunkIndex } = location;

    // 预加载前后各1个chunk
    const promises: Promise<void>[] = [];

    if (chunkIndex > 0) {
      promises.push(this.chunkManager.loadChunkByIndex(chunkIndex - 1));
    }

    if (chunkIndex < this.chunkManager.getAllChunkMetadata().length - 1) {
      promises.push(this.chunkManager.loadChunkByIndex(chunkIndex + 1));
    }

    await Promise.all(promises).catch(() => {
      // 静默失败，不影响主流程
    });
  }

  /**
   * 获取当前可见的 heading ID
   */
  public getActiveHeadingId(): string | undefined {
    const loadedHeadings = this.getLoadedHeadings();
    const HEADING_OFFSET = 20; // 与 Contents.tsx 保持一致

    let activeId = loadedHeadings[0]?.id;

    for (const heading of loadedHeadings) {
      const element = document.getElementById(heading.id);
      if (!element) continue;

      const bounding = element.getBoundingClientRect();

      if (bounding.top > HEADING_OFFSET) {
        break;
      }

      activeId = heading.id;
    }

    return activeId;
  }

  /**
   * 清理资源
   */
  public destroy() {
    this.allHeadings.clear();
    this.updateCallbacks.clear();
  }
}
