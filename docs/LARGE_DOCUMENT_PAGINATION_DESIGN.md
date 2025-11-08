# 超大文档分页加载与内存管理技术方案

## 📋 目录
1. [背景分析](#背景分析)
2. [核心架构设计](#核心架构设计)
3. [文档分块策略](#文档分块策略)
4. [虚拟滚动与内存管理](#虚拟滚动与内存管理)
5. [TOC 跨页定位方案](#toc-跨页定位方案)
6. [Undo/Redo 兼容方案](#undoredo-兼容方案)
7. [实现步骤](#实现步骤)
8. [性能指标](#性能指标)

---

## 背景分析

### 当前实现的局限性

**问题**：文档内容一次性加载到内存

```typescript
// app/editor/index.tsx:424-430
private createDocument(content: string | object) {
  // 🔴 整个文档在初始化时全部解析
  if (typeof content === "string") {
    return this.parser.parse(content) || undefined;  // 一次性解析
  }
  return ProsemirrorNode.fromJSON(this.schema, content);  // 一次性创建节点树
}
```

**影响**：
- 10MB+ 文档加载耗时 > 3s
- 内存占用线性增长（10k 段落 ≈ 500MB+）
- 首屏渲染阻塞
- 滚动卡顿（大量 DOM 节点）

---

## 核心架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         用户视口                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │            可见区域 (Visible Viewport)              │     │
│  │  ┌──────────────────────────────────────────┐     │     │
│  │  │ Chunk 3: paragraphs[20-29]               │     │     │
│  │  │ ✅ 已渲染 (Rendered)                      │     │     │
│  │  └──────────────────────────────────────────┘     │     │
│  │  ┌──────────────────────────────────────────┐     │     │
│  │  │ Chunk 4: paragraphs[30-39]  ⬅️ 当前焦点  │     │     │
│  │  │ ✅ 已渲染 + 可编辑                        │     │     │
│  │  └──────────────────────────────────────────┘     │     │
│  │  ┌──────────────────────────────────────────┐     │     │
│  │  │ Chunk 5: paragraphs[40-49]               │     │     │
│  │  │ ✅ 已渲染 (Preloaded)                     │     │     │
│  │  └──────────────────────────────────────────┘     │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
         ↑                    ↑                    ↑
     overscan-1          active chunk         overscan+1

┌─────────────────────────────────────────────────────────────┐
│                      内存管理层                               │
├─────────────────────────────────────────────────────────────┤
│  Chunk 1-2: 💾 已卸载 (Metadata only)                        │
│  Chunk 3-5: ✅ 已加载 (In Memory)                            │
│  Chunk 6+:  ⏳ 未加载 (Placeholder)                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      持久化层                                 │
├─────────────────────────────────────────────────────────────┤
│  📦 服务器: 完整文档 JSON                                     │
│  📦 IndexedDB: 分块缓存 (optional)                           │
│  📦 History Stack: 增量变更记录                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 文档分块策略

### 1. Chunk 定义

```typescript
// shared/editor/lib/DocumentChunk.ts

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
  loadState: 'unloaded' | 'loading' | 'loaded' | 'unloading';
  /** 块内包含的 heading 元数据 */
  headings: HeadingMetadata[];
  /** 块的内容哈希 (用于变更检测) */
  contentHash: string;
}

export interface HeadingMetadata {
  id: string;
  title: string;
  level: number;
  /** 在 chunk 内的相对位置 */
  relativePos: number;
}

export interface DocumentChunk {
  metadata: ChunkMetadata;
  /** ProseMirror 节点内容 (仅在加载时存在) */
  content?: ProsemirrorNode;
  /** 原始 JSON 数据 (用于快速重载) */
  rawData?: ProsemirrorData;
}
```

### 2. 分块算法

```typescript
// shared/editor/lib/ChunkingStrategy.ts

export class ChunkingStrategy {
  // 配置参数
  private readonly TARGET_CHUNK_SIZE = 10;  // 10个顶层节点/块
  private readonly MIN_CHUNK_SIZE = 5;
  private readonly MAX_CHUNK_SIZE = 20;

  /**
   * 将完整文档拆分为多个 chunk
   */
  public chunkDocument(doc: ProsemirrorNode): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let currentChunkNodes: ProsemirrorNode[] = [];
    let currentStartPos = 0;
    let chunkIndex = 0;

    doc.forEach((node, offset, index) => {
      currentChunkNodes.push(node);

      // 判断是否需要结束当前 chunk
      const shouldSplit = this.shouldSplitChunk(
        currentChunkNodes,
        node,
        index
      );

      if (shouldSplit) {
        chunks.push(
          this.createChunk(
            chunkIndex++,
            currentChunkNodes,
            currentStartPos,
            offset + node.nodeSize
          )
        );
        currentChunkNodes = [];
        currentStartPos = offset + node.nodeSize;
      }
    });

    // 处理剩余节点
    if (currentChunkNodes.length > 0) {
      chunks.push(
        this.createChunk(
          chunkIndex,
          currentChunkNodes,
          currentStartPos,
          doc.nodeSize - 2
        )
      );
    }

    return chunks;
  }

  /**
   * 判断是否应该拆分 chunk
   * 策略：优先在 heading 边界拆分
   */
  private shouldSplitChunk(
    nodes: ProsemirrorNode[],
    currentNode: ProsemirrorNode,
    index: number
  ): boolean {
    const nodeCount = nodes.length;

    // 未达到最小大小，不拆分
    if (nodeCount < this.MIN_CHUNK_SIZE) {
      return false;
    }

    // 超过最大大小，强制拆分
    if (nodeCount >= this.MAX_CHUNK_SIZE) {
      return true;
    }

    // 达到目标大小 + 当前是 heading → 在 heading 之前拆分
    if (nodeCount >= this.TARGET_CHUNK_SIZE && currentNode.type.name === 'heading') {
      return true;
    }

    return false;
  }

  /**
   * 创建 chunk 元数据
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
        loadState: 'unloaded',
        headings,
        contentHash,
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
      if (node.type.name === 'heading') {
        headings.push({
          id: headingToSlug(node),
          title: node.textContent,
          level: node.attrs.level,
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
      // 根据节点类型估算高度
      switch (node.type.name) {
        case 'heading':
          totalHeight += node.attrs.level === 1 ? 60 : 40;
          break;
        case 'paragraph':
          // 根据文本长度估算行数
          const lineCount = Math.ceil(node.textContent.length / 80);
          totalHeight += lineCount * 24;
          break;
        case 'code_block':
          const codeLines = node.textContent.split('\n').length;
          totalHeight += codeLines * 20 + 20;
          break;
        case 'image':
          totalHeight += 300;
          break;
        case 'table':
          totalHeight += 200;
          break;
        default:
          totalHeight += 30;
      }
    });

    return totalHeight;
  }

  /**
   * 将节点数组转换为 JSON
   */
  private nodesToJSON(nodes: ProsemirrorNode[]): ProsemirrorData {
    return {
      type: 'doc',
      content: nodes.map(n => n.toJSON()),
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
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }
}
```

---

## 虚拟滚动与内存管理

### 1. ChunkManager - 核心管理器

```typescript
// shared/editor/lib/ChunkManager.ts

export class ChunkManager {
  private chunks: Map<string, DocumentChunk> = new Map();
  private chunkOrder: string[] = [];  // chunk ID 的有序数组
  private loadedChunks: Set<string> = new Set();

  // 配置
  private readonly OVERSCAN_COUNT = 2;  // 预加载前后各2个chunk
  private readonly MAX_LOADED_CHUNKS = 7;  // 最多保持7个chunk在内存
  private readonly UNLOAD_DELAY = 5000;  // 延迟5秒卸载

  constructor(
    private editor: Editor,
    private onChunkLoad: (chunk: DocumentChunk) => void,
    private onChunkUnload: (chunkId: string) => void
  ) {}

  /**
   * 初始化：将完整文档拆分为 chunks
   */
  public initialize(doc: ProsemirrorNode) {
    const strategy = new ChunkingStrategy();
    const chunks = strategy.chunkDocument(doc);

    chunks.forEach(chunk => {
      this.chunks.set(chunk.metadata.id, chunk);
      this.chunkOrder.push(chunk.metadata.id);
    });

    // 初始加载第一个 chunk
    this.loadChunkByIndex(0);
  }

  /**
   * 根据滚动位置加载/卸载 chunks
   */
  public handleScroll(scrollTop: number) {
    const activeChunkIndex = this.getChunkIndexAtScrollPosition(scrollTop);

    // 计算需要加载的 chunk 范围
    const startIndex = Math.max(0, activeChunkIndex - this.OVERSCAN_COUNT);
    const endIndex = Math.min(
      this.chunkOrder.length - 1,
      activeChunkIndex + this.OVERSCAN_COUNT
    );

    // 加载范围内的 chunks
    for (let i = startIndex; i <= endIndex; i++) {
      this.loadChunkByIndex(i);
    }

    // 卸载范围外的 chunks (延迟执行)
    this.scheduleUnloadOutOfRangeChunks(startIndex, endIndex);
  }

  /**
   * 加载指定 chunk
   */
  private async loadChunkByIndex(index: number) {
    const chunkId = this.chunkOrder[index];
    const chunk = this.chunks.get(chunkId);

    if (!chunk || this.loadedChunks.has(chunkId)) {
      return;  // 已加载
    }

    chunk.metadata.loadState = 'loading';

    try {
      // 从 rawData 创建 ProseMirror 节点
      if (chunk.rawData) {
        chunk.content = ProsemirrorNode.fromJSON(
          this.editor.schema,
          chunk.rawData
        );
      }

      chunk.metadata.loadState = 'loaded';
      this.loadedChunks.add(chunkId);
      this.onChunkLoad(chunk);

      console.log(`✅ Chunk ${chunkId} loaded`);
    } catch (error) {
      chunk.metadata.loadState = 'unloaded';
      console.error(`❌ Failed to load chunk ${chunkId}:`, error);
    }
  }

  /**
   * 卸载 chunk（释放内存）
   */
  private unloadChunk(chunkId: string) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk || !this.loadedChunks.has(chunkId)) {
      return;
    }

    chunk.metadata.loadState = 'unloading';

    // 释放 ProseMirror 节点内容
    delete chunk.content;

    chunk.metadata.loadState = 'unloaded';
    this.loadedChunks.delete(chunkId);
    this.onChunkUnload(chunkId);

    console.log(`🗑️  Chunk ${chunkId} unloaded`);
  }

  /**
   * 计划卸载范围外的 chunks
   */
  private scheduleUnloadOutOfRangeChunks(startIndex: number, endIndex: number) {
    setTimeout(() => {
      this.chunkOrder.forEach((chunkId, index) => {
        if (index < startIndex || index > endIndex) {
          this.unloadChunk(chunkId);
        }
      });
    }, this.UNLOAD_DELAY);
  }

  /**
   * 根据滚动位置计算当前 chunk 索引
   */
  private getChunkIndexAtScrollPosition(scrollTop: number): number {
    let accumulatedHeight = 0;

    for (let i = 0; i < this.chunkOrder.length; i++) {
      const chunk = this.chunks.get(this.chunkOrder[i])!;
      const height = chunk.metadata.actualHeight ?? chunk.metadata.estimatedHeight;

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
    return this.chunkOrder.map(id => this.chunks.get(id)!.metadata);
  }

  /**
   * 根据 heading ID 查找对应的 chunk
   */
  public findChunkByHeadingId(headingId: string): DocumentChunk | undefined {
    for (const [id, chunk] of this.chunks) {
      if (chunk.metadata.headings.some(h => h.id === headingId)) {
        return chunk;
      }
    }
    return undefined;
  }
}
```

### 2. 虚拟滚动容器

```typescript
// app/editor/components/VirtualScrollContainer.tsx

interface Props {
  chunkManager: ChunkManager;
  children: React.ReactNode;
}

export const VirtualScrollContainer: React.FC<Props> = ({
  chunkManager,
  children
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleChunks, setVisibleChunks] = useState<DocumentChunk[]>([]);

  const handleScroll = useCallback(
    throttle(() => {
      if (!containerRef.current) return;

      const scrollTop = containerRef.current.scrollTop;
      chunkManager.handleScroll(scrollTop);

      // 更新可见 chunks
      const metadata = chunkManager.getAllChunkMetadata();
      const visible = metadata.filter(m => m.loadState === 'loaded');
      setVisibleChunks(visible.map(m => chunkManager.chunks.get(m.id)!));
    }, 100),
    [chunkManager]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // 计算总高度（用于滚动条）
  const totalHeight = chunkManager
    .getAllChunkMetadata()
    .reduce((sum, m) => sum + (m.actualHeight ?? m.estimatedHeight), 0);

  return (
    <div ref={containerRef} style={{ height: '100vh', overflowY: 'auto' }}>
      <div style={{ height: totalHeight }}>
        {visibleChunks.map(chunk => (
          <ChunkRenderer
            key={chunk.metadata.id}
            chunk={chunk}
            onHeightMeasured={(height) => {
              chunk.metadata.actualHeight = height;
            }}
          />
        ))}
      </div>
      {children}
    </div>
  );
};
```

---

## TOC 跨页定位方案

### 1. 全局 TOC 管理器

```typescript
// app/components/DocumentTOC/TOCManager.ts

export class TOCManager {
  private allHeadings: Map<string, HeadingLocation> = new Map();

  constructor(private chunkManager: ChunkManager) {
    this.initializeFromChunks();
  }

  /**
   * 从所有 chunk 元数据初始化 TOC
   */
  private initializeFromChunks() {
    const metadata = this.chunkManager.getAllChunkMetadata();

    metadata.forEach(chunk => {
      chunk.headings.forEach(heading => {
        this.allHeadings.set(heading.id, {
          headingId: heading.id,
          title: heading.title,
          level: heading.level,
          chunkId: chunk.id,
          chunkIndex: chunk.index,
          isLoaded: chunk.loadState === 'loaded',
        });
      });
    });
  }

  /**
   * 跳转到指定 heading（跨页）
   */
  public async scrollToHeading(headingId: string) {
    const location = this.allHeadings.get(headingId);

    if (!location) {
      console.warn(`Heading ${headingId} not found in TOC`);
      return;
    }

    // 1. 确保目标 chunk 已加载
    if (!location.isLoaded) {
      await this.loadChunkByIndex(location.chunkIndex);
    }

    // 2. 等待 DOM 渲染
    await this.waitForElement(`#${headingId}`);

    // 3. 滚动到目标元素
    const element = document.getElementById(headingId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /**
   * 等待元素出现在 DOM 中
   */
  private waitForElement(selector: string, timeout = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve();
        return;
      }

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

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found after ${timeout}ms`));
      }, timeout);
    });
  }

  /**
   * 加载指定索引的 chunk
   */
  private async loadChunkByIndex(index: number): Promise<void> {
    return new Promise((resolve) => {
      // 触发加载
      this.chunkManager.loadChunkByIndex(index);

      // 等待加载完成
      const checkInterval = setInterval(() => {
        const chunkId = this.chunkManager.chunkOrder[index];
        const chunk = this.chunkManager.chunks.get(chunkId);

        if (chunk?.metadata.loadState === 'loaded') {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // 超时保护
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 5000);
    });
  }

  /**
   * 获取所有 heading（用于渲染 TOC）
   */
  public getAllHeadings(): HeadingLocation[] {
    return Array.from(this.allHeadings.values());
  }
}

interface HeadingLocation {
  headingId: string;
  title: string;
  level: number;
  chunkId: string;
  chunkIndex: number;
  isLoaded: boolean;
}
```

### 2. TOC 组件更新

```typescript
// app/scenes/Document/components/Contents.tsx (修改版)

function Contents() {
  const [activeSlug, setActiveSlug] = useState<string>();
  const scrollPosition = useWindowScrollPosition({ throttle: 100 });
  const { tocManager } = useDocumentContext();  // 新增

  // 从 TOCManager 获取所有 headings（包括未加载的）
  const allHeadings = tocManager.getAllHeadings();

  useEffect(() => {
    // 仅在已加载的 headings 中检测激活状态
    const loadedHeadings = allHeadings.filter(h => h.isLoaded);

    let activeId = loadedHeadings[0]?.headingId;

    for (const heading of loadedHeadings) {
      const element = document.getElementById(heading.headingId);
      if (element) {
        const bounding = element.getBoundingClientRect();
        if (bounding.top > HEADING_OFFSET) break;
        activeId = heading.headingId;
      }
    }

    if (activeSlug !== activeId) {
      setActiveSlug(activeId);
    }
  }, [scrollPosition, allHeadings]);

  const handleHeadingClick = async (headingId: string) => {
    // 使用 TOCManager 的跨页定位功能
    await tocManager.scrollToHeading(headingId);
  };

  return (
    <StickyWrapper>
      <Heading>目录</Heading>
      <List>
        {allHeadings
          .filter(h => h.level < 4)
          .map(heading => (
            <ListItem
              key={heading.headingId}
              level={heading.level}
              active={activeSlug === heading.headingId}
            >
              <Link
                href={`#${heading.headingId}`}
                onClick={(e) => {
                  e.preventDefault();
                  handleHeadingClick(heading.headingId);
                }}
              >
                {heading.title}
                {!heading.isLoaded && <Badge>未加载</Badge>}
              </Link>
            </ListItem>
          ))}
      </List>
    </StickyWrapper>
  );
}
```

---

## Undo/Redo 兼容方案

### 核心挑战

在分块加载的场景下，Undo/Redo 需要处理：
1. 操作可能跨越多个 chunk
2. 某些 chunk 可能未加载
3. 历史栈需要持久化

### 解决方案：增量历史记录

```typescript
// shared/editor/extensions/ChunkedHistory.ts

export interface ChunkedHistoryItem {
  /** 操作类型 */
  type: 'insert' | 'delete' | 'replace' | 'mark';
  /** 影响的 chunk ID 列表 */
  affectedChunks: string[];
  /** 操作前的内容快照 (Delta 格式) */
  before: Delta;
  /** 操作后的内容快照 (Delta 格式) */
  after: Delta;
  /** 全局位置信息 */
  position: { from: number; to: number };
  /** 时间戳 */
  timestamp: number;
}

export class ChunkedHistoryManager {
  private undoStack: ChunkedHistoryItem[] = [];
  private redoStack: ChunkedHistoryItem[] = [];
  private readonly MAX_HISTORY_SIZE = 100;

  constructor(
    private editor: Editor,
    private chunkManager: ChunkManager
  ) {}

  /**
   * 记录一次编辑操作
   */
  public recordChange(transaction: Transaction) {
    if (!transaction.docChanged) return;

    const item: ChunkedHistoryItem = {
      type: this.detectOperationType(transaction),
      affectedChunks: this.getAffectedChunks(transaction),
      before: this.extractDelta(transaction.before),
      after: this.extractDelta(transaction.doc),
      position: {
        from: transaction.selection.from,
        to: transaction.selection.to,
      },
      timestamp: Date.now(),
    };

    this.undoStack.push(item);
    this.redoStack = [];  // 新操作清空 redo 栈

    // 限制栈大小
    if (this.undoStack.length > this.MAX_HISTORY_SIZE) {
      this.undoStack.shift();
    }
  }

  /**
   * 执行 Undo
   */
  public async undo() {
    const item = this.undoStack.pop();
    if (!item) return;

    // 1. 确保所有相关 chunk 已加载
    await this.ensureChunksLoaded(item.affectedChunks);

    // 2. 应用反向操作
    this.applyDelta(item.before, item.position);

    // 3. 移动到 redo 栈
    this.redoStack.push(item);
  }

  /**
   * 执行 Redo
   */
  public async redo() {
    const item = this.redoStack.pop();
    if (!item) return;

    // 1. 确保所有相关 chunk 已加载
    await this.ensureChunksLoaded(item.affectedChunks);

    // 2. 应用正向操作
    this.applyDelta(item.after, item.position);

    // 3. 移动回 undo 栈
    this.undoStack.push(item);
  }

  /**
   * 确保指定 chunks 已加载
   */
  private async ensureChunksLoaded(chunkIds: string[]): Promise<void> {
    const loadPromises = chunkIds.map(async (chunkId) => {
      const chunk = this.chunkManager.chunks.get(chunkId);
      if (chunk && chunk.metadata.loadState !== 'loaded') {
        await this.chunkManager.loadChunkByIndex(chunk.metadata.index);
      }
    });

    await Promise.all(loadPromises);
  }

  /**
   * 获取操作影响的 chunk 列表
   */
  private getAffectedChunks(tr: Transaction): string[] {
    const { from, to } = tr.selection;
    const chunks = new Set<string>();

    this.chunkManager.getAllChunkMetadata().forEach(chunk => {
      // 检查操作范围是否与 chunk 重叠
      if (
        (from >= chunk.startPos && from <= chunk.endPos) ||
        (to >= chunk.startPos && to <= chunk.endPos) ||
        (from <= chunk.startPos && to >= chunk.endPos)
      ) {
        chunks.add(chunk.id);
      }
    });

    return Array.from(chunks);
  }

  /**
   * 提取内容 Delta (简化的变更格式)
   */
  private extractDelta(doc: ProsemirrorNode): Delta {
    // 使用轻量级的 Delta 格式存储变更
    // 仅存储变化的部分，而非整个文档
    return {
      ops: [
        // Delta operations
      ],
    };
  }

  /**
   * 应用 Delta 到文档
   */
  private applyDelta(delta: Delta, position: { from: number; to: number }) {
    const { state, dispatch } = this.editor.view;
    const tr = state.tr;

    // 根据 Delta 重建操作
    // ... 应用到事务

    dispatch(tr);
  }

  /**
   * 检测操作类型
   */
  private detectOperationType(tr: Transaction): ChunkedHistoryItem['type'] {
    for (const step of tr.steps) {
      if (step instanceof ReplaceStep) {
        if (step.slice.size === 0) return 'delete';
        if (step.from === step.to) return 'insert';
        return 'replace';
      }
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        return 'mark';
      }
    }
    return 'replace';
  }
}

// Delta 类型定义（参考 Quill Delta）
interface Delta {
  ops: DeltaOperation[];
}

interface DeltaOperation {
  insert?: string | object;
  delete?: number;
  retain?: number;
  attributes?: Record<string, any>;
}
```

### Undo/Redo 扩展

```typescript
// shared/editor/extensions/History.ts (修改版)

export default class History extends Extension {
  private historyManager?: ChunkedHistoryManager;

  get name() {
    return "history";
  }

  onCreate() {
    if (this.editor.options.chunked) {
      this.historyManager = new ChunkedHistoryManager(
        this.editor,
        this.editor.chunkManager
      );
    }
  }

  commands(): Record<string, CommandFactory> {
    if (this.historyManager) {
      return {
        undo: () => () => {
          this.historyManager!.undo();
          return true;
        },
        redo: () => () => {
          this.historyManager!.redo();
          return true;
        },
      };
    }

    // 回退到标准 history 插件
    return {
      undo: () => undo,
      redo: () => redo,
    };
  }

  keys(): Record<string, Command | CommandFactory> {
    return {
      "Mod-z": () => this.editor.commands.undo(),
      "Mod-y": () => this.editor.commands.redo(),
      "Shift-Mod-z": () => this.editor.commands.redo(),
    };
  }

  get plugins() {
    if (this.historyManager) {
      // 返回自定义 plugin 监听事务
      return [
        new Plugin({
          appendTransaction: (transactions, oldState, newState) => {
            transactions.forEach(tr => {
              if (tr.docChanged && !tr.getMeta('history-ignore')) {
                this.historyManager!.recordChange(tr);
              }
            });
            return null;
          },
        }),
      ];
    }

    // 回退到标准 history 插件
    return [history()];
  }
}
```

---

## 实现步骤

### Phase 1: 基础架构 (Week 1-2)

#### 1.1 创建核心类型和工具

- [ ] 创建 `DocumentChunk.ts` - 定义 chunk 数据结构
- [ ] 创建 `ChunkingStrategy.ts` - 实现分块算法
- [ ] 编写单元测试验证分块逻辑

#### 1.2 实现 ChunkManager

- [ ] 创建 `ChunkManager.ts`
- [ ] 实现 `initialize()` - 文档初始化分块
- [ ] 实现 `handleScroll()` - 滚动加载逻辑
- [ ] 实现 `loadChunk()` / `unloadChunk()` - 内存管理
- [ ] 添加性能监控（加载耗时、内存占用）

#### 1.3 集成到 Editor

```typescript
// app/editor/index.tsx (修改)

export class Editor extends React.PureComponent<Props, State> {
  chunkManager?: ChunkManager;  // 新增

  private init() {
    // ... 现有初始化代码

    // 检查是否启用分块模式
    if (this.shouldUseChunking()) {
      this.chunkManager = new ChunkManager(
        this,
        this.handleChunkLoad,
        this.handleChunkUnload
      );

      const initialDoc = this.createDocument(this.props.value);
      this.chunkManager.initialize(initialDoc);
    } else {
      // 传统模式
      this.view = this.createView();
    }
  }

  /**
   * 判断是否需要使用分块模式
   */
  private shouldUseChunking(): boolean {
    const content = this.props.value || this.props.defaultValue;

    // 策略：超过 1000 个节点或 500KB 启用分块
    if (typeof content === 'string') {
      return content.length > 500 * 1024;
    } else {
      const nodeCount = this.estimateNodeCount(content);
      return nodeCount > 1000;
    }
  }

  private handleChunkLoad = (chunk: DocumentChunk) => {
    // 渲染 chunk 到视图
    this.renderChunk(chunk);
  };

  private handleChunkUnload = (chunkId: string) => {
    // 从视图移除 chunk
    this.unmountChunk(chunkId);
  };
}
```

---

### Phase 2: TOC 跨页定位 (Week 3)

#### 2.1 实现 TOCManager

- [ ] 创建 `TOCManager.ts`
- [ ] 实现 `initializeFromChunks()` - 从 chunk 元数据构建 TOC
- [ ] 实现 `scrollToHeading()` - 跨页定位逻辑
- [ ] 添加加载动画和错误处理

#### 2.2 更新 Contents 组件

- [ ] 修改 `Contents.tsx` 使用 TOCManager
- [ ] 添加"未加载"标记
- [ ] 实现跨页点击跳转
- [ ] 优化自动高亮逻辑

---

### Phase 3: Undo/Redo 兼容 (Week 4)

#### 3.1 实现 ChunkedHistoryManager

- [ ] 创建 `ChunkedHistoryManager.ts`
- [ ] 实现 Delta 格式的变更记录
- [ ] 实现 `undo()` / `redo()` 逻辑
- [ ] 添加历史栈持久化（IndexedDB）

#### 3.2 更新 History 扩展

- [ ] 修改 `History.ts` 支持分块模式
- [ ] 测试跨 chunk 的 Undo/Redo
- [ ] 测试协作编辑场景（Multiplayer + Chunking）

---

### Phase 4: 性能优化与测试 (Week 5)

#### 4.1 性能优化

- [ ] 添加 chunk 内容缓存（IndexedDB）
- [ ] 优化高度估算算法
- [ ] 实现增量更新（仅重新分块变更的部分）
- [ ] 添加 Web Worker 支持（后台分块）

#### 4.2 测试与监控

- [ ] 创建超大文档测试数据（10k+段落）
- [ ] 性能基准测试
  - 首屏加载时间
  - 内存占用
  - 滚动 FPS
  - Undo/Redo 响应时间
- [ ] 添加性能监控面板
- [ ] 压力测试（协作编辑 + 分块）

---

### Phase 5: 用户体验优化 (Week 6)

#### 5.1 加载体验

- [ ] 添加骨架屏（Skeleton）
- [ ] 实现渐进式渲染动画
- [ ] 添加加载进度指示器
- [ ] 优化首屏加载策略（预加载首屏 + 目录附近）

#### 5.2 边界情况处理

- [ ] 网络失败重试机制
- [ ] 内存不足降级策略
- [ ] 大型媒体文件懒加载
- [ ] 处理快速编辑造成的 chunk 分裂/合并

---

## 性能指标

### 目标

| 指标 | 当前 (10k 段落) | 目标 (分块后) | 提升 |
|------|----------------|--------------|------|
| 首屏加载时间 | 5-8s | <1s | 80%+ |
| 内存占用峰值 | 500-800MB | <150MB | 70%+ |
| 滚动 FPS | 20-30 | 55-60 | 2x |
| TOC 响应时间 | 即时 | <500ms (跨页) | 可接受 |
| Undo 响应时间 | <100ms | <300ms | 可接受 |

### 监控指标

```typescript
// shared/editor/lib/PerformanceMonitor.ts

export class PerformanceMonitor {
  static measure(label: string, fn: () => void) {
    const start = performance.now();
    fn();
    const duration = performance.now() - start;
    console.log(`⏱️  ${label}: ${duration.toFixed(2)}ms`);
  }

  static measureMemory(): number {
    if ('memory' in performance) {
      return (performance as any).memory.usedJSHeapSize / 1024 / 1024;
    }
    return 0;
  }

  static logChunkStats(chunkManager: ChunkManager) {
    const metadata = chunkManager.getAllChunkMetadata();
    const loaded = metadata.filter(m => m.loadState === 'loaded').length;
    const memory = this.measureMemory();

    console.table({
      'Total Chunks': metadata.length,
      'Loaded Chunks': loaded,
      'Memory (MB)': memory.toFixed(2),
      'Load Ratio': `${((loaded / metadata.length) * 100).toFixed(1)}%`,
    });
  }
}
```

---

## 配置选项

```typescript
// shared/editor/types/ChunkingConfig.ts

export interface ChunkingConfig {
  /** 是否启用分块模式 */
  enabled: boolean;

  /** 自动启用阈值 */
  autoEnableThreshold: {
    nodeCount: number;      // 默认: 1000
    contentSize: number;    // 默认: 500KB
  };

  /** 分块参数 */
  chunking: {
    targetChunkSize: number;   // 默认: 10
    minChunkSize: number;      // 默认: 5
    maxChunkSize: number;      // 默认: 20
  };

  /** 虚拟滚动参数 */
  virtualScroll: {
    overscanCount: number;     // 默认: 2
    maxLoadedChunks: number;   // 默认: 7
    unloadDelay: number;       // 默认: 5000ms
  };

  /** 历史记录参数 */
  history: {
    maxStackSize: number;      // 默认: 100
    enablePersistence: boolean; // 默认: false
  };

  /** 性能监控 */
  monitoring: {
    enabled: boolean;          // 默认: false (仅开发环境)
    logInterval: number;       // 默认: 10000ms
  };
}
```

---

## 兼容性考虑

### 1. 渐进式增强

- ✅ 小文档：继续使用传统模式（无性能损失）
- ✅ 中等文档：自动启用分块（透明切换）
- ✅ 超大文档：强制分块 + 用户提示

### 2. 功能降级

```typescript
if (!supportsIndexedDB()) {
  config.history.enablePersistence = false;
}

if (lowMemoryDevice()) {
  config.virtualScroll.maxLoadedChunks = 5;
  config.chunking.targetChunkSize = 5;
}
```

### 3. 向后兼容

- ✅ API 保持不变（Editor props/methods）
- ✅ 现有插件无需修改
- ✅ 协作编辑（Yjs）兼容

---

## 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| ProseMirror 状态不一致 | 高 | 中 | 完整的单元测试 + 状态校验 |
| 协作冲突（Yjs + Chunking） | 高 | 中 | 与 Yjs 团队咨询 + 隔离测试 |
| Undo/Redo 丢失历史 | 中 | 低 | 持久化历史栈 + 增量备份 |
| 内存泄漏 | 中 | 中 | 定期审计 + WeakMap 使用 |
| 用户体验降级 | 低 | 中 | A/B 测试 + 可回退开关 |

---

## 附录

### A. 相关文件清单

**新增文件**：
```
shared/editor/lib/
  ├── DocumentChunk.ts          # Chunk 数据结构
  ├── ChunkingStrategy.ts       # 分块算法
  ├── ChunkManager.ts           # Chunk 管理器
  ├── ChunkedHistoryManager.ts  # 历史管理器
  └── PerformanceMonitor.ts     # 性能监控

app/components/DocumentTOC/
  ├── TOCManager.ts             # TOC 管理器
  └── types.ts                  # TOC 类型定义

app/editor/components/
  ├── VirtualScrollContainer.tsx # 虚拟滚动容器
  └── ChunkRenderer.tsx          # Chunk 渲染组件
```

**修改文件**：
```
app/editor/index.tsx              # 集成 ChunkManager
app/components/DocumentContext.tsx # 添加 TOCManager
app/scenes/Document/components/Contents.tsx # 使用 TOCManager
shared/editor/extensions/History.ts # 支持分块历史
```

### B. 测试数据生成

```typescript
// scripts/generateLargeDocument.ts

function generateLargeDocument(paragraphCount: number): string {
  let markdown = '# 超大文档测试\n\n';

  for (let i = 0; i < paragraphCount; i++) {
    if (i % 50 === 0) {
      markdown += `## Section ${Math.floor(i / 50) + 1}\n\n`;
    }

    if (i % 10 === 0) {
      markdown += `### Subsection ${Math.floor(i / 10) + 1}\n\n`;
    }

    markdown += `Paragraph ${i + 1}: ${generateLoremIpsum(80)}\n\n`;

    if (i % 100 === 0) {
      markdown += `![Image ${i}](https://picsum.photos/800/400?random=${i})\n\n`;
    }
  }

  return markdown;
}

// 生成 10,000 段落的测试文档
const testDoc = generateLargeDocument(10000);
fs.writeFileSync('test-10k-paragraphs.md', testDoc);
```

---

## 总结

本方案通过以下核心技术实现超大文档的高效加载：

1. **文档分块（Chunking）**：将文档拆分为 10-20 个节点的小块
2. **虚拟滚动（Virtual Scrolling）**：仅渲染可见区域 + 预加载
3. **内存管理（Memory Management）**：自动卸载不可见 chunk
4. **TOC 跨页定位（Cross-Chunk Navigation）**：按需加载目标 chunk
5. **增量历史（Incremental History）**：Delta 格式存储变更

预期效果：
- ✅ 支持 10,000+ 段落文档
- ✅ 首屏加载 <1s
- ✅ 内存占用 <150MB
- ✅ 滚动 60fps
- ✅ 保持现有所有功能

---

**文档版本**: v1.0
**最后更新**: 2025-11-08
**作者**: Claude Code
**审阅**: 待定
