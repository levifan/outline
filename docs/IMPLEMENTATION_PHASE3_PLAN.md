# Phase 3 实施方案 - Editor 集成与虚拟滚动

## 📋 概述

Phase 3 的目标是将 Phase 1 和 Phase 2 的功能集成到 Editor 组件中，实现真正的文档分块加载和虚拟滚动。

---

## 🎯 核心挑战

### 1. **架构问题**

当前 Editor 的设计假设：
- 整个文档一次性加载到 `EditorView`
- 所有节点都在 ProseMirror 的文档树中
- 编辑操作直接作用于完整文档

分块模式需要：
- 仅部分内容在 EditorView 中
- 动态加载/卸载 chunks
- 编辑操作可能跨越多个 chunks

### 2. **集成方式选择**

有两种集成方式：

#### 方案 A：修改 Editor 核心（侵入式）
**优点**：
- 完全控制，性能最优
- 深度集成所有功能

**缺点**：
- 高风险，可能破坏现有功能
- 需要大量测试
- 回滚困难

#### 方案 B：包装 Editor（渐进式）✅ **推荐**
**优点**：
- 低风险，不影响现有功能
- 易于测试和回滚
- 可以逐步优化

**缺点**：
- 可能有额外的性能开销
- 需要额外的抽象层

---

## ✅ 推荐方案：渐进式集成

### 架构设计

```
┌─────────────────────────────────────────────────┐
│          DocumentEditor (现有组件)               │
│  ┌───────────────────────────────────────────┐  │
│  │  shouldUseChunking() 判断                  │  │
│  │    ↓                                       │  │
│  │    ├─→ 传统模式 → 直接使用 Editor          │  │
│  │    └─→ 分块模式 → 使用 ChunkedEditor      │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘

传统模式：
┌──────────────┐
│    Editor    │  ← 现有实现，不变
└──────────────┘

分块模式：
┌───────────────────────────────────┐
│       ChunkedEditorWrapper         │
│  ┌─────────────────────────────┐  │
│  │   ChunkManager              │  │
│  │   TOCManager                │  │
│  └─────────────────────────────┘  │
│  ┌─────────────────────────────┐  │
│  │   VirtualScrollContainer    │  │
│  │    ├─ ChunkRenderer (1)     │  │
│  │    ├─ ChunkRenderer (2)     │  │
│  │    └─ ChunkRenderer (3)     │  │
│  └─────────────────────────────┘  │
└───────────────────────────────────┘
```

---

## 📝 实施步骤

### Step 1: 创建判断逻辑

在 `DocumentEditor.tsx` 中添加判断：

```typescript
// app/scenes/Document/components/Editor.tsx

import { ChunkingStrategy } from '@shared/editor/lib/ChunkingStrategy';
import { DEFAULT_CHUNKING_CONFIG } from '@shared/editor/lib/DocumentChunk';

function DocumentEditor(props: Props, ref: React.RefObject<any>) {
  // ... 现有代码

  // 判断是否使用分块模式
  const shouldUseChunking = useMemo(() => {
    const content = props.defaultValue;

    if (typeof content === 'string') {
      return content.length > 500 * 1024; // 500KB
    } else {
      const nodeCount = ChunkingStrategy.estimateNodeCount(content);
      return nodeCount > 1000;
    }
  }, [props.defaultValue]);

  // 根据模式选择组件
  if (shouldUseChunking) {
    return <ChunkedEditorWrapper {...props} ref={ref} />;
  } else {
    return <RegularEditor {...props} ref={ref} />;
  }
}
```

### Step 2: 创建 ChunkedEditorWrapper

```typescript
// app/editor/components/ChunkedEditorWrapper.tsx

interface Props extends EditorProps {
  // ... 继承所有 Editor props
}

export const ChunkedEditorWrapper = React.forwardRef<Editor, Props>(
  function ChunkedEditorWrapper(props, ref) {
    const { setChunkManager } = useDocumentContext();
    const [chunkManager, setLocalChunkManager] = useState<ChunkManager>();
    const editorRef = useRef<Editor>(null);

    // 初始化 ChunkManager
    useEffect(() => {
      if (!editorRef.current) return;

      const editor = editorRef.current;
      const doc = createDocument(props.defaultValue, editor.schema);

      const manager = new ChunkManager(
        editor.schema,
        DEFAULT_CHUNKING_CONFIG,
        handleChunkLoad,
        handleChunkUnload
      );

      manager.initialize(doc);
      setLocalChunkManager(manager);
      setChunkManager(manager);

      return () => {
        manager.destroy();
        setChunkManager(undefined);
      };
    }, []);

    const handleChunkLoad = (chunk: DocumentChunk) => {
      // 将 chunk 渲染到视图
      console.log('Chunk loaded:', chunk.metadata.id);
    };

    const handleChunkUnload = (chunkId: string) => {
      // 从视图移除 chunk
      console.log('Chunk unloaded:', chunkId);
    };

    return (
      <div>
        {chunkManager && (
          <VirtualScrollContainer chunkManager={chunkManager}>
            <Editor
              ref={mergeRefs([ref, editorRef])}
              {...props}
              readOnly={true}  // 暂时只读模式
            />
          </VirtualScrollContainer>
        )}
      </div>
    );
  }
);
```

### Step 3: 创建 VirtualScrollContainer

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

  // 监听滚动
  const handleScroll = useCallback(
    throttle(() => {
      if (!containerRef.current) return;

      const scrollTop = containerRef.current.scrollTop;
      chunkManager.handleScroll(scrollTop);

      // 更新可见 chunks
      const loaded = chunkManager.getLoadedChunks();
      setVisibleChunks(loaded);
    }, 100),
    [chunkManager]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // 计算总高度
  const totalHeight = chunkManager.getTotalHeight();

  return (
    <ScrollContainer ref={containerRef}>
      <ContentWrapper style={{ height: totalHeight }}>
        {visibleChunks.map((chunk, index) => (
          <ChunkRenderer
            key={chunk.metadata.id}
            chunk={chunk}
            offsetTop={calculateOffsetTop(chunk, chunkManager)}
            onHeightMeasured={(height) => {
              chunkManager.updateChunkHeight(chunk.metadata.id, height);
            }}
          />
        ))}
      </ContentWrapper>
      {children}
    </ScrollContainer>
  );
};

const ScrollContainer = styled.div`
  height: 100vh;
  overflow-y: auto;
  position: relative;
`;

const ContentWrapper = styled.div`
  position: relative;
`;

function calculateOffsetTop(
  chunk: DocumentChunk,
  manager: ChunkManager
): number {
  const allChunks = manager.getAllChunkMetadata();
  let offset = 0;

  for (const metadata of allChunks) {
    if (metadata.id === chunk.metadata.id) {
      break;
    }
    offset += metadata.actualHeight ?? metadata.estimatedHeight;
  }

  return offset;
}
```

### Step 4: 创建 ChunkRenderer

```typescript
// app/editor/components/ChunkRenderer.tsx

interface Props {
  chunk: DocumentChunk;
  offsetTop: number;
  onHeightMeasured: (height: number) => void;
}

export const ChunkRenderer: React.FC<Props> = ({
  chunk,
  offsetTop,
  onHeightMeasured
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // 测量高度
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      const height = entries[0].contentRect.height;
      onHeightMeasured(height);
    });

    resizeObserver.observe(containerRef.current);

    return () => resizeObserver.disconnect();
  }, [onHeightMeasured]);

  if (!chunk.content) {
    return (
      <ChunkPlaceholder
        ref={containerRef}
        style={{
          position: 'absolute',
          top: offsetTop,
          height: chunk.metadata.estimatedHeight,
        }}
      >
        Loading...
      </ChunkPlaceholder>
    );
  }

  return (
    <ChunkContainer
      ref={containerRef}
      style={{
        position: 'absolute',
        top: offsetTop,
      }}
    >
      {/* 渲染 chunk 内容 */}
      <ChunkContent content={chunk.content} />
    </ChunkContainer>
  );
};

const ChunkContainer = styled.div`
  width: 100%;
`;

const ChunkPlaceholder = styled.div`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
`;
```

### Step 5: 创建 ChunkContent

```typescript
// app/editor/components/ChunkContent.tsx

interface Props {
  content: ProsemirrorNode;
}

export const ChunkContent: React.FC<Props> = ({ content }) => {
  // 将 ProseMirror 节点渲染为 HTML
  const html = useMemo(() => {
    return renderNodeToHTML(content);
  }, [content]);

  return (
    <ContentWrapper dangerouslySetInnerHTML={{ __html: html }} />
  );
};

function renderNodeToHTML(node: ProsemirrorNode): string {
  // 简单的渲染逻辑（可以使用 ProseMirror 的序列化器）
  let html = '';

  node.forEach((child) => {
    switch (child.type.name) {
      case 'heading':
        const level = child.attrs.level;
        html += `<h${level} id="${getHeadingId(child)}">${child.textContent}</h${level}>`;
        break;

      case 'paragraph':
        html += `<p>${child.textContent}</p>`;
        break;

      // ... 其他节点类型
    }
  });

  return html;
}

const ContentWrapper = styled.div`
  /* 应用 Editor 样式 */
  font-family: inherit;
  font-size: inherit;
  line-height: 1.5;

  h1 { font-size: 2em; margin: 0.67em 0; }
  h2 { font-size: 1.5em; margin: 0.75em 0; }
  h3 { font-size: 1.17em; margin: 0.83em 0; }
  p { margin: 1em 0; }
`;
```

---

## 🚧 限制与权衡

### Phase 3 的范围限制

为了快速实现和验证概念，Phase 3 将有以下限制：

#### 1. **只读模式**
- 分块模式下暂不支持编辑
- 用户可以查看、滚动、TOC 导航
- 编辑功能在 Phase 4 实现

#### 2. **简化渲染**
- 使用 HTML 渲染，不是完整的 ProseMirror View
- 足以验证虚拟滚动和内存管理
- 完整的 ProseMirror 集成在 Phase 4

#### 3. **无协作编辑**
- 暂不支持 Multiplayer
- Phase 4 集成 Yjs

---

## 📊 Phase 3 预期成果

### 功能完成度

| 功能 | Phase 3 | Phase 4 |
|------|---------|---------|
| **虚拟滚动** | ✅ | ✅ |
| **内存管理** | ✅ | ✅ |
| **TOC 导航** | ✅ | ✅ |
| **内容查看** | ✅ | ✅ |
| **内容编辑** | ❌ | ✅ |
| **Undo/Redo** | ❌ | ✅ |
| **协作编辑** | ❌ | ✅ |

### 性能验证

Phase 3 完成后应该能够：

1. ✅ 加载 10,000+ 段落文档
2. ✅ 首屏加载 <1s
3. ✅ 内存占用 <150MB
4. ✅ 滚动 60fps
5. ✅ TOC 跨页导航 <800ms

---

## 🔧 测试方案

### 1. 创建测试数据

```typescript
// scripts/generateLargeDocument.ts

function generateLargeMarkdown(paragraphs: number): string {
  let markdown = '# Large Document Test\n\n';

  for (let i = 0; i < paragraphs; i++) {
    if (i % 50 === 0) {
      markdown += `## Chapter ${Math.floor(i / 50) + 1}\n\n`;
    }

    if (i % 10 === 0) {
      markdown += `### Section ${Math.floor(i / 10) + 1}\n\n`;
    }

    markdown += `Paragraph ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. `;
    markdown += `Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\n`;
  }

  return markdown;
}

// 生成 10,000 段落测试文档
const testDoc = generateLargeMarkdown(10000);
fs.writeFileSync('test-10k-paragraphs.md', testDoc);
```

### 2. 性能基准测试

```typescript
// app/editor/components/__tests__/ChunkPerformance.test.tsx

describe('Chunking Performance', () => {
  it('should load 10k paragraphs in <1s', async () => {
    const start = performance.now();

    const content = generateLargeMarkdown(10000);
    const wrapper = mount(<ChunkedEditorWrapper defaultValue={content} />);

    await waitFor(() => {
      expect(wrapper.find(ChunkRenderer)).toHaveLength(greaterThan(0));
    });

    const duration = performance.now() - start;
    expect(duration).toBeLessThan(1000);
  });

  it('should keep memory under 150MB', async () => {
    const content = generateLargeMarkdown(10000);
    const wrapper = mount(<ChunkedEditorWrapper defaultValue={content} />);

    await waitFor(() => {
      const memory = (performance as any).memory.usedJSHeapSize / 1024 / 1024;
      expect(memory).toBeLessThan(150);
    });
  });
});
```

---

## 📚 文件清单

### 新增文件（Phase 3）

```
app/editor/components/
├── ChunkedEditorWrapper.tsx     (~150 lines)
├── VirtualScrollContainer.tsx   (~120 lines)
├── ChunkRenderer.tsx            (~100 lines)
└── ChunkContent.tsx             (~80 lines)

app/scenes/Document/components/
└── Editor.tsx                   (修改 ~30 lines)

docs/
└── IMPLEMENTATION_PHASE3_PLAN.md  (本文档)
```

**预计新增代码**: ~500行

---

## 🎯 成功标准

Phase 3 成功的标志：

1. ✅ 10,000 段落文档能够加载
2. ✅ 首屏加载时间 <1s
3. ✅ 滚动流畅，60fps
4. ✅ 内存占用 <150MB
5. ✅ TOC 导航正常工作
6. ✅ 不影响传统模式

---

## 🔜 Phase 4 规划

Phase 3 完成后，Phase 4 将实现：

1. **分块编辑支持**
   - 跨 chunk 的编辑操作
   - 实时的 chunk 分裂/合并

2. **ChunkedHistoryManager**
   - Delta 格式历史记录
   - 跨 chunk 的 Undo/Redo

3. **协作编辑集成**
   - Yjs + Chunking
   - 实时同步

4. **完整的 ProseMirror 渲染**
   - 每个 chunk 有独立的 EditorView
   - 无缝的编辑体验

---

**文档版本**: v1.0
**创建日期**: 2025-11-08
**状态**: 规划中
**预计工作量**: 2-3 天
