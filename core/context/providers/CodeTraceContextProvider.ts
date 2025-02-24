import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  ContextSubmenuItem,
  FileType,
  LoadSubmenuItemsArgs,
} from "../../index.js";
import { CodeDefinitionsCodebaseIndex } from "../../indexing/CodeDefinitionsIndex.js";
import { CodeSnippetsCodebaseIndex } from "../../indexing/CodeSnippetsIndex.js";
import { joinPathsToUri } from "../../util/uri.js";
import { BaseContextProvider } from "../index.js";
const CODE_TRACE_DIR = ".codetrace";
const MAX_SUBMENU_ITEMS = 1000;

type TraceNode = {
  className: string;
  methodName: string;
  lineNumber: number;
  children: TraceNode[];
};

type CodeTrace = {
  name: string;
  description: string;
  traceTree: TraceNode;
}

class CodeTraceContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "Code Trace",
    displayTitle: "Code Trace",
    description: "Type to search",
    type: "submenu",
    dependsOnIndexing: true,
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    // Assume the query is the id as returned by loadSubmenuItems
    const [workspace] = await extras.ide.getWorkspaceDirs();
    const traceDir = joinPathsToUri(workspace, CODE_TRACE_DIR);
    // load code trace in workspace
    return [
      await CodeDefinitionsCodebaseIndex.getForId(
        Number.parseInt(query, 10),
        workspaceDirs,
      ),
    ];
  }

  async loadSubmenuItems(
    args: LoadSubmenuItemsArgs,
  ): Promise<ContextSubmenuItem[]> {
    const [workspace] = await args.ide.getWorkspaceDirs();
    const codeTraceDir = joinPathsToUri(workspace, CODE_TRACE_DIR);
    if (!(await args.ide.fileExists(codeTraceDir))) {
      return [];
    }

    const files = await args.ide.listDir(codeTraceDir);
    const submenuItems: ContextSubmenuItem[] = [];

    for (const file of files) {
      if (file[1] !== FileType.File || !file[0].endsWith('.json')) {
        continue;
      }

      try {
        const content = await args.ide.readFile(joinPathsToUri(codeTraceDir, file[0]));
        const trace = JSON.parse(content) as CodeTrace;
        submenuItems.push({
          id: file[0],
          title: trace.name,
          description: trace.description
        });
      } catch (error) {
        console.warn(`Failed to parse trace file ${file}:`, error);
      }
    }

    return submenuItems;
  }
}

export default CodeTraceContextProvider;
