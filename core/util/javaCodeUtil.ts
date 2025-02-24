import { SyntaxNode } from "web-tree-sitter";

import { JAVA_NODE_TYPES } from "../indexing/chunk/javaCode";

/**
 * 从代码中提取节点对应的内容
 * @param node 语法树节点
 * @param code 源代码字符串
 */
export function getNodeContent(node: SyntaxNode, code: string): string {
    return code.slice(node.startIndex, node.endIndex);
}

/**
 * 获取节点对应的类名
 * @param node 语法树节点
 * @returns 类名或undefined
 */
export function getClassName(node: SyntaxNode): string | undefined {
    let className: string | undefined;
    
    // 如果当前节点是类声明，直接查找标识符
    if (node.type === JAVA_NODE_TYPES.CLASS) {
        const identifier = node.children.find(child => child.type === "identifier");
        className = identifier?.text;
    } else {
        // 如果不是类声明，向上查找最近的类声明节点
        let current = node.parent;
        while (current) {
            if (current.type === JAVA_NODE_TYPES.CLASS) {
                const identifier = current.children.find(child => child.type === "identifier");
                className = identifier?.text;
                break;
            }
            current = current.parent;
        }
    }

    if (!className) {return undefined;}

    // Get package name
    const packageName = getPackageName(node);
    
    // Combine package name and class name
    return packageName ? `${packageName}.${className}` : className;
}

/**
 * 获取包名
 * @param node 语法树节点
 */
export function getPackageName(node: SyntaxNode): string | undefined {
    let current = node;
    while (current.parent) {
        current = current.parent;
    }
    
    const packageDecl = current.children.find(child => 
        child.type === JAVA_NODE_TYPES.PACKAGE
    );
    
    if (packageDecl) {
        // Get all identifiers in the package declaration
        const identifiers = packageDecl.children
            .filter(child => child.type === "identifier")
            .map(child => child.text);
        return identifiers.join(".");
    }
    return undefined;
}

/**
 * 生成内部类的完整类名
 * @param node 内部类节点
 * @param outerClassName 外部类名
 */
export function getInnerClassName(node: SyntaxNode, outerClassName: string): string | undefined {
    const identifier = node.children.find(child => child.type === "identifier");
    if (identifier) {
        return `${outerClassName}.${identifier.text}`;
    }
    return undefined;
}