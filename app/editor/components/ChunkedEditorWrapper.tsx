import React, { useEffect, useMemo, useRef } from "react";
import { Node as ProsemirrorNode } from "prosemirror-model";
import { ChunkManager } from "@shared/editor/lib/ChunkManager";
import { DEFAULT_CHUNKING_CONFIG } from "@shared/editor/lib/DocumentChunk";
import { ProsemirrorHelper } from "@shared/utils/ProsemirrorHelper";
import { ProsemirrorData } from "@shared/types";
import { useDocumentContext } from "~/components/DocumentContext";
import { VirtualScrollContainer } from "./VirtualScrollContainer";
import Logger from "~/utils/Logger";

interface Props {
  /** The editor content value */
  value?: string | ProsemirrorData;
  /** Whether the editor is in read-only mode */
  readOnly?: boolean;
  /** The document ID */
  documentId?: string;
  /** Children to render (typically the ClickablePadding) */
  children?: React.ReactNode;
}

/**
 * Chunked Editor Wrapper
 *
 * This component determines whether to use chunked virtual scrolling
 * for large documents in read-only mode.
 *
 * Phase 3 Scope:
 * - Read-only display only
 * - Virtual scrolling with chunk loading/unloading
 * - Integration with TOC for cross-chunk navigation
 *
 * Phase 4 will add:
 * - Full editing support in chunked mode
 * - Undo/Redo with delta-based history
 * - Real-time collaboration
 */
export const ChunkedEditorWrapper: React.FC<Props> = ({
  value,
  readOnly,
  documentId,
  children,
}) => {
  // Safely get document context
  let documentContext;
  try {
    documentContext = useDocumentContext();
  } catch {
    // Context not available - return null to disable chunking
    return null;
  }

  const { setChunkManager } = documentContext;
  const chunkManagerRef = useRef<ChunkManager>();

  // Parse the document content
  const documentNode = useMemo(() => {
    if (!value || typeof value === "string") {
      return null;
    }

    try {
      return ProsemirrorHelper.deserialize(value);
    } catch (error) {
      Logger.error("Failed to parse document for chunking", "ChunkedEditor", {
        error,
      });
      return null;
    }
  }, [value]);

  // Determine if chunking should be enabled
  const shouldUseChunking = useMemo(() => {
    if (!readOnly || !documentNode) {
      return false;
    }

    const threshold = DEFAULT_CHUNKING_CONFIG.autoEnableThreshold;
    const nodeCount = documentNode.childCount;
    const contentSize = JSON.stringify(value).length;

    const exceedsNodeThreshold = nodeCount > threshold.nodeCount;
    const exceedsSizeThreshold = contentSize > threshold.contentSize;

    if (exceedsNodeThreshold || exceedsSizeThreshold) {
      Logger.info(
        `Chunking enabled for document (nodes: ${nodeCount}, size: ${contentSize} bytes)`,
        "ChunkedEditor"
      );
      return true;
    }

    return false;
  }, [readOnly, documentNode, value]);

  // Initialize ChunkManager when chunking is enabled
  useEffect(() => {
    if (shouldUseChunking && documentNode) {
      try {
        const manager = new ChunkManager(
          documentNode,
          {
            ...DEFAULT_CHUNKING_CONFIG,
            enabled: true,
          },
          documentId
        );

        chunkManagerRef.current = manager;
        setChunkManager(manager);

        Logger.info("ChunkManager initialized", "ChunkedEditor", {
          totalChunks: manager.getAllChunkMetadata().length,
          totalHeight: manager.getTotalHeight(),
        });

        return () => {
          Logger.info("ChunkManager cleanup", "ChunkedEditor");
          setChunkManager(undefined);
          chunkManagerRef.current = undefined;
        };
      } catch (error) {
        Logger.error("Failed to initialize ChunkManager", "ChunkedEditor", {
          error,
        });
        setChunkManager(undefined);
      }
    } else {
      // Ensure ChunkManager is cleared when not using chunking
      setChunkManager(undefined);
      chunkManagerRef.current = undefined;
    }
  }, [shouldUseChunking, documentNode, documentId, setChunkManager]);

  // Render with virtual scrolling if chunking is enabled
  if (shouldUseChunking && chunkManagerRef.current) {
    return (
      <VirtualScrollContainer chunkManager={chunkManagerRef.current}>
        {children}
      </VirtualScrollContainer>
    );
  }

  // For non-chunked mode, return null - the parent component will render the normal editor
  return null;
};
