import { action, computed, observable } from "mobx";
import { createContext, useContext, useMemo, PropsWithChildren } from "react";
import { Heading } from "@shared/utils/ProsemirrorHelper";
import { ChunkManager } from "@shared/editor/lib/ChunkManager";
import Document from "~/models/Document";
import { Editor } from "~/editor";
import { TOCManager } from "~/components/DocumentTOC";

class DocumentContext {
  /** The current document */
  document?: Document;

  /** The editor instance for this document */
  editor?: Editor;

  /** The chunk manager for large documents */
  chunkManager?: ChunkManager;

  /** The TOC manager for cross-chunk navigation */
  tocManager?: TOCManager;

  /** The ID of the currently focused comment, or null if no comment is focused */
  @observable
  focusedCommentId: string | null = null;

  /** Whether the editor has been initialized */
  @observable
  isEditorInitialized: boolean = false;

  /** The headings in the document */
  @observable
  headings: Heading[] = [];

  /** Whether chunking is enabled for this document */
  @observable
  isChunkingEnabled: boolean = false;

  @computed
  get hasHeadings() {
    return this.headings.length > 0;
  }

  @action
  setDocument = (document: Document) => {
    this.document = document;
    this.updateState();
  };

  @action
  setEditor = (editor: Editor) => {
    this.editor = editor;
    this.updateState();
  };

  @action
  setChunkManager = (chunkManager: ChunkManager | undefined) => {
    this.chunkManager = chunkManager;

    // 创建或销毁 TOCManager
    if (chunkManager) {
      this.tocManager = new TOCManager(chunkManager);
      this.isChunkingEnabled = true;
    } else {
      this.tocManager?.destroy();
      this.tocManager = undefined;
      this.isChunkingEnabled = false;
    }
  };

  @action
  setEditorInitialized = (initialized: boolean) => {
    this.isEditorInitialized = initialized;
  };

  @action
  setFocusedCommentId = (commentId: string | null) => {
    this.focusedCommentId = commentId;
  };

  @action
  updateState = () => {
    this.updateHeadings();
    this.updateTasks();
  };

  private updateHeadings() {
    // 如果启用了分块，从 TOCManager 获取 headings
    if (this.isChunkingEnabled && this.tocManager) {
      const tocHeadings = this.tocManager.getAllHeadings();
      const currHeadings = tocHeadings.map((h) => ({
        id: h.id,
        title: h.title,
        level: h.level,
      }));

      const hasChanged =
        currHeadings.map((h) => h.level + h.title).join("") !==
        this.headings.map((h) => h.level + h.title).join("");

      if (hasChanged) {
        this.headings = currHeadings;
      }
    } else {
      // 传统模式：从 editor 获取 headings
      const currHeadings = this.editor?.getHeadings() ?? [];
      const hasChanged =
        currHeadings.map((h) => h.level + h.title).join("") !==
        this.headings.map((h) => h.level + h.title).join("");

      if (hasChanged) {
        this.headings = currHeadings;
      }
    }
  }

  private updateTasks() {
    const tasks = this.editor?.getTasks() ?? [];
    const total = tasks.length ?? 0;
    const completed = tasks.filter((t) => t.completed).length ?? 0;
    this.document?.updateTasks(total, completed);
  }
}

const Context = createContext<DocumentContext | null>(null);

export const useDocumentContext = () => {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error(
      "useDocumentContext must be used within DocumentContextProvider"
    );
  }
  return ctx;
};

export const DocumentContextProvider = ({
  children,
}: PropsWithChildren<unknown>) => {
  const context = useMemo(() => new DocumentContext(), []);
  return <Context.Provider value={context}>{children}</Context.Provider>;
};
