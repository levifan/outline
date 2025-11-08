import React, { useRef, useCallback, useState, useEffect } from "react";
import styled from "styled-components";
import { DocumentChunk } from "@shared/editor/lib/DocumentChunk";
import { ChunkManager } from "@shared/editor/lib/ChunkManager";
import { ChunkRenderer } from "./ChunkRenderer";

interface Props {
  chunkManager: ChunkManager;
  children?: React.ReactNode;
}

/**
 * 虚拟滚动容器
 * 负责渲染可见的 chunks 并管理滚动
 */
export const VirtualScrollContainer: React.FC<Props> = ({
  chunkManager,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleChunks, setVisibleChunks] = useState<DocumentChunk[]>([]);

  // 初始加载
  useEffect(() => {
    const loaded = chunkManager.getLoadedChunks();
    setVisibleChunks(loaded);
  }, [chunkManager]);

  // 监听滚动
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const scrollTop = containerRef.current.scrollTop;
    chunkManager.handleScroll(scrollTop);

    // 更新可见 chunks
    const loaded = chunkManager.getLoadedChunks();
    setVisibleChunks(loaded);
  }, [chunkManager]);

  // 节流滚动事件
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timeoutId: NodeJS.Timeout;
    const throttledScroll = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(handleScroll, 100);
    };

    container.addEventListener("scroll", throttledScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", throttledScroll);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [handleScroll]);

  // 计算总高度
  const totalHeight = chunkManager.getTotalHeight();

  // 计算每个 chunk 的偏移量
  const calculateOffsetTop = (chunk: DocumentChunk): number => {
    const allChunks = chunkManager.getAllChunkMetadata();
    let offset = 0;

    for (const metadata of allChunks) {
      if (metadata.id === chunk.metadata.id) {
        break;
      }
      offset += metadata.actualHeight ?? metadata.estimatedHeight;
    }

    return offset;
  };

  return (
    <ScrollContainer ref={containerRef}>
      <ContentWrapper style={{ height: totalHeight }}>
        {visibleChunks.map((chunk) => (
          <ChunkRenderer
            key={chunk.metadata.id}
            chunk={chunk}
            offsetTop={calculateOffsetTop(chunk)}
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
  height: 100%;
  overflow-y: auto;
  position: relative;
`;

const ContentWrapper = styled.div`
  position: relative;
  width: 100%;
`;
