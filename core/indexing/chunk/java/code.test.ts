
import { codeChunker } from "./code";

describe("Java Code Chunker", () => {
      const testComplexCode = `
            
            package com.example.test;
            import java.util.List;
            import java.util.ArrayList;
            import org.example.utils.Helper;
            public class OuterClass {
                  private String field;
                  
                  public OuterClass() {
                        this.field = "";
                  }
                  
                  public OuterClass(String field) {
                        this.field = field;
                  }
                  
                  public void outerMethod() {
                        System.out.println("outer");
                  }
                  
                  static class InnerClass {
                        private int value;
                        
                        public static final void innerMethod() {
                              System.out.println("inner");
                        }
                        
                        interface DeepNestedClass {
                              default void deepMethod() {
                                    System.out.println("deep");
                              }
                              String deepMethod1();
                        }
                  }
            }
      `;

      it("should handle complex class structure with inner classes and multiple constructors", async () => {
            const chunks = [];
            for await (const chunk of codeChunker("TestClass.java", testComplexCode)) {
                  chunks.push(chunk);
            }

            // Verify class definitions
            expect(chunks.filter(c => c.type === "class_definition")).toHaveLength(1);

            const classChunk = chunks.find(c => c.type === "class_definition");
            expect(classChunk?.className).toBe("com.example.test.OuterClass");

            // Verify all method chunks
            const methodChunks = chunks.filter(c => c.type === "method_definition");

            // Should find all methods
            expect(methodChunks).toHaveLength(3);

            // Verify constructors
            expect(methodChunks.filter(m => m.methodIdentifier?.startsWith("OuterClass[")))
                  .toHaveLength(2);

            // Verify outer method
            expect(methodChunks.find(m => m.methodIdentifier?.startsWith("outerMethod")))
                  .toBeDefined();

            // Verify inner class method
            const innerMethod = methodChunks.find(m => m.methodIdentifier?.startsWith("innerMethod"));
            expect(innerMethod).toBeDefined();
            expect(innerMethod?.className).toBe("com.example.test.OuterClass$InnerClass");

            // Verify deep nested class method
            const deepMethod = methodChunks.find(m => m.methodIdentifier?.startsWith("deepMethod"));
            expect(deepMethod).toBeDefined();
            expect(deepMethod?.className)
                  .toBe("com.example.test.OuterClass$InnerClass$DeepNestedClass");
      });
});