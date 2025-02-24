import { SyntaxNode } from "web-tree-sitter";

import { ChunkWithoutID } from "../../../index.js";
import { getParserForFile } from "../../../util/treeSitter.js";
import { Chunk } from "../../../vendor/modules/@xenova/transformers/src/pipelines.js";

// 常量定义
const NODE_TYPES = {
      PACKAGE: "package_declaration",
      CLASS: "class_declaration",
      INTERFACE: "interface_declaration",
      METHOD: "method_declaration",
      CONSTRUCTOR: "constructor_declaration",
      ENUM: "enum_declaration",
      ANNOTATION: "annotation_type_declaration",
      CLASS_BODY: "class_body",
      INTERFACE_BODY: "interface_body",
      IDENTIFIER: "identifier",
      PARAMETERS: "formal_parameters",
      BLOCK: "block"
} as const;

// 类型定义
type JavaChunkType = "class_definition" | "method_definition";

interface JavaChunkWithoutID extends ChunkWithoutID {
      methodIdentifier?: string;
      type: JavaChunkType;
}
interface JavaChunk extends JavaChunkWithoutID, Chunk {

}
// 工具函数
function findNodeByType(node: SyntaxNode, type: string): SyntaxNode | null {
      if (node.type === type) { return node; }

      for (const child of node.children) {
            const result = findNodeByType(child, type);
            if (result) { return result; }
      }

      return null;
}

function isClassOrInterface(node: SyntaxNode): boolean {
      return NODE_TYPES.CLASS === node.type || NODE_TYPES.INTERFACE === node.type;
}
function isClassOrInterfaceBody(node: SyntaxNode): boolean {
      return NODE_TYPES.CLASS_BODY === node.type || NODE_TYPES.INTERFACE_BODY === node.type;
}
function isCollapsedNode(node: SyntaxNode): boolean {
      return node.type === NODE_TYPES.METHOD;
}

// 类名相关函数
function getPackageName(node: SyntaxNode): string {
      let current = node;
      while (current.parent) {
            current = current.parent;
      }
      const packageNode = findNodeByType(current, NODE_TYPES.PACKAGE);
      return packageNode
            ? packageNode.text.replace("package ", "").replace(";", "").trim()
            : "";
}

function getSimpleClassName(node: SyntaxNode): string {
      const classNameNode = findNodeByType(node, NODE_TYPES.IDENTIFIER);
      return classNameNode ? classNameNode.text : "";
}

function getFullClassName(node: SyntaxNode, parentClassName?: string): string {
      const packageName = getPackageName(node);
      const className = getSimpleClassName(node);

      const fullClassName = packageName ? `${packageName}.${className}` : className;
      return parentClassName ? `${parentClassName}$${fullClassName}` : fullClassName;
}

// 方法相关函数
function getMethodIdentifier(methodNode: SyntaxNode): string {
      const nameNode = methodNode.children.find(child => child.type === NODE_TYPES.IDENTIFIER);

      if (!nameNode) { return ""; }

      return `${nameNode.text}[${methodNode.startPosition.row}-${methodNode.endPosition.row}]`;
}


// 类定义处理
interface MethodCollapsed {
      start: number;
      end: number;
      collapsedStr: string;
}

// Helper function to collect method body replacements
function collectMethodCollapseds(
      methodNode: SyntaxNode,
      baseOffset: number
): MethodCollapsed | null {
      const bodyNode = methodNode.children.find(n => n.type === NODE_TYPES.BLOCK);
      if (!bodyNode) { return null; }

      const methodIdentifier = getMethodIdentifier(methodNode);
      const start = bodyNode.startIndex - baseOffset;
      const end = bodyNode.endIndex - baseOffset;

      return {
            start,
            end,
            collapsedStr: `{ id:${methodIdentifier} }`
      };
}

// Helper function to collect method replacements recursively
function collectMethodCollapsedsRecursively(
      node: SyntaxNode,
      baseOffset: number,
      collapseds: MethodCollapsed[]
): void {
      if (isCollapsedNode(node)) {
            const collapsed = collectMethodCollapseds(node, baseOffset);
            if (collapsed) {
                  collapseds.push(collapsed);
            }
            return;
      }

      // Handle class body (both top-level and inner classes)
      const classBody = isClassOrInterfaceBody(node) ?
            node :
            node.children.find(child => isClassOrInterfaceBody(child));

      if (!classBody) { return; }

      // Process all children recursively
      for (const child of classBody.children) {
            if (child.type === NODE_TYPES.METHOD || isClassOrInterface(child)) {
                  collectMethodCollapsedsRecursively(child, baseOffset, collapseds);
            }
      }
}

// Helper function to chunk method recursively
async function* chunkMethodRecursively(
      node: SyntaxNode,
): AsyncGenerator<JavaChunkWithoutID> {
      if (isCollapsedNode(node)) {
            if (node.startPosition.row === node.endPosition.row) {
                  return;
            }
            yield {
                  content: node.text,
                  startLine: node.startPosition.row,
                  endLine: node.endPosition.row,
                  methodIdentifier: getMethodIdentifier(node),
                  type: "method_definition"
            };
            return;
      }

      // Handle class body (both top-level and inner classes)
      const classBody = isClassOrInterfaceBody(node) ?
            node :
            node.children.find(child => isClassOrInterfaceBody(child));

      if (!classBody) { return; }

      // Process all children recursively
      for (const child of classBody.children) {
            if (child.type === NODE_TYPES.METHOD || isClassOrInterface(child)) {
                  yield* chunkMethodRecursively(child);
            }
      }
}

async function collapseMethodBody(node: SyntaxNode, code: string): Promise<string> {
      let modifiedCode = code;
      const collapseds: MethodCollapsed[] = [];

      // Start recursive collection from the class body
      collectMethodCollapsedsRecursively(node, node.startIndex, collapseds);

      // Sort collapseds from bottom to top
      collapseds.sort((a, b) => b.start - a.start);

      // Apply collapseds in reverse order
      for (const { start, end, collapsedStr } of collapseds) {
            modifiedCode = modifiedCode.slice(0, start) + collapsedStr + modifiedCode.slice(end);
      }

      return modifiedCode;
}

async function getCollapsedClassDefinition(
      node: SyntaxNode,
      code: string,
): Promise<JavaChunkWithoutID> {
      const modifiedCode = await collapseMethodBody(node, code.slice(node.startIndex, node.endIndex));
      const importsAndPackage = code.slice(0, node.startIndex);
      return {
            content: importsAndPackage + modifiedCode,
            startLine: 0,
            endLine: node.endPosition.row,
            type: "class_definition"
      };
}

// 主函数
export async function* codeChunker(
      filepath: string,
      contents: string
): AsyncGenerator<JavaChunkWithoutID> {
      if (contents.trim().length === 0) { return; }

      const parser = await getParserForFile(filepath);
      if (!parser) {
            throw new Error(`Failed to load parser for file ${filepath}`);
      }

      const tree = parser.parse(contents);
      const root = tree.rootNode;

      for (const node of root.children) {
            if (isClassOrInterface(node)) {
                  // 处理类定义
                  yield getCollapsedClassDefinition(node, contents);
                  // 处理方法
                  yield* chunkMethodRecursively(node);
            } else if (NODE_TYPES.ENUM === node.type || NODE_TYPES.ANNOTATION === node.type) {
                  yield {
                        content: contents,
                        startLine: node.startPosition.row,
                        endLine: node.endPosition.row,
                        type: "class_definition"
                  };
            }
      }
}
