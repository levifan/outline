import React, { useRef, useEffect } from "react";
import styled from "styled-components";
import { Node as ProsemirrorNode } from "prosemirror-model";
import { DocumentChunk } from "@shared/editor/lib/DocumentChunk";
import headingToSlug from "@shared/editor/lib/headingToSlug";

interface Props {
  chunk: DocumentChunk;
  offsetTop: number;
  onHeightMeasured: (height: number) => void;
}

/**
 * Chunk 渲染器
 * 负责渲染单个 chunk 的内容并测量高度
 */
export const ChunkRenderer: React.FC<Props> = ({
  chunk,
  offsetTop,
  onHeightMeasured,
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

    // 初始测量
    const initialHeight = containerRef.current.offsetHeight;
    if (initialHeight > 0) {
      onHeightMeasured(initialHeight);
    }

    return () => resizeObserver.disconnect();
  }, [onHeightMeasured]);

  // 如果内容未加载，显示占位符
  if (!chunk.content) {
    return (
      <ChunkPlaceholder
        ref={containerRef}
        style={{
          position: "absolute",
          top: offsetTop,
          minHeight: chunk.metadata.estimatedHeight,
        }}
      >
        <LoadingText>Loading chunk {chunk.metadata.index + 1}...</LoadingText>
      </ChunkPlaceholder>
    );
  }

  // 渲染内容
  return (
    <ChunkContainer
      ref={containerRef}
      style={{
        position: "absolute",
        top: offsetTop,
      }}
      data-chunk-id={chunk.metadata.id}
    >
      <ChunkContent content={chunk.content} />
    </ChunkContainer>
  );
};

/**
 * Chunk 内容渲染
 */
const ChunkContent: React.FC<{ content: ProsemirrorNode }> = ({ content }) => {
  const html = renderNodeToHTML(content);

  return <ContentWrapper dangerouslySetInnerHTML={{ __html: html }} />;
};

/**
 * 将 ProseMirror 节点渲染为 HTML
 * 这是简化版本，仅用于只读显示
 */
function renderNodeToHTML(node: ProsemirrorNode): string {
  let html = "";

  node.forEach((child) => {
    html += renderSingleNode(child);
  });

  return html;
}

function renderSingleNode(node: ProsemirrorNode): string {
  switch (node.type.name) {
    case "heading": {
      const level = node.attrs.level as number;
      const id = headingToSlug(node);
      const text = node.textContent;
      return `<h${level} id="${id}">${escapeHtml(text)}</h${level}>`;
    }

    case "paragraph": {
      const text = node.textContent;
      return `<p>${escapeHtml(text)}</p>`;
    }

    case "code_block": {
      const text = node.textContent;
      return `<pre><code>${escapeHtml(text)}</code></pre>`;
    }

    case "blockquote": {
      const inner = renderNodeToHTML(node);
      return `<blockquote>${inner}</blockquote>`;
    }

    case "bullet_list": {
      let items = "";
      node.forEach((item) => {
        items += `<li>${renderNodeToHTML(item)}</li>`;
      });
      return `<ul>${items}</ul>`;
    }

    case "ordered_list": {
      let items = "";
      node.forEach((item) => {
        items += `<li>${renderNodeToHTML(item)}</li>`;
      });
      return `<ol>${items}</ol>`;
    }

    case "horizontal_rule": {
      return `<hr />`;
    }

    case "image": {
      const src = node.attrs.src as string;
      const alt = node.attrs.alt as string;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}" />`;
    }

    default: {
      // 未知节点类型，尝试渲染文本内容
      const text = node.textContent;
      return text ? `<p>${escapeHtml(text)}</p>` : "";
    }
  }
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };

  return text.replace(/[&<>"']/g, (char) => map[char]);
}

const ChunkContainer = styled.div`
  width: 100%;
  padding: 0 32px;
`;

const ChunkPlaceholder = styled.div`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
`;

const LoadingText = styled.div`
  color: ${(props) => props.theme.textTertiary};
  font-size: 14px;
`;

const ContentWrapper = styled.div`
  /* 应用 Editor 样式 */
  font-family: ${(props) => props.theme.fontFamily};
  font-size: ${(props) => props.theme.fontSize}px;
  line-height: 1.6;
  color: ${(props) => props.theme.text};

  /* Headings */
  h1 {
    font-size: 2em;
    font-weight: 600;
    margin: 0.67em 0;
    line-height: 1.25;
  }

  h2 {
    font-size: 1.5em;
    font-weight: 600;
    margin: 0.75em 0;
    line-height: 1.25;
  }

  h3 {
    font-size: 1.17em;
    font-weight: 600;
    margin: 0.83em 0;
    line-height: 1.25;
  }

  h4,
  h5,
  h6 {
    font-weight: 600;
    margin: 1em 0;
    line-height: 1.25;
  }

  /* Paragraphs */
  p {
    margin: 1em 0;
  }

  /* Code */
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.9em;
    background: ${(props) => props.theme.codeBackground};
    padding: 2px 4px;
    border-radius: 3px;
  }

  pre {
    background: ${(props) => props.theme.codeBackground};
    padding: 16px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 1em 0;

    code {
      background: none;
      padding: 0;
    }
  }

  /* Lists */
  ul,
  ol {
    padding-left: 2em;
    margin: 1em 0;
  }

  li {
    margin: 0.5em 0;
  }

  /* Blockquote */
  blockquote {
    border-left: 4px solid ${(props) => props.theme.divider};
    padding-left: 1em;
    margin: 1em 0;
    color: ${(props) => props.theme.textSecondary};
  }

  /* Horizontal Rule */
  hr {
    border: none;
    border-top: 2px solid ${(props) => props.theme.divider};
    margin: 2em 0;
  }

  /* Images */
  img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1em 0;
  }
`;
