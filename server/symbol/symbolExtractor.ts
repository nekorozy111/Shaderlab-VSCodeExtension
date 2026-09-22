import {
  HlslCBufferNode,
  HlslDeclarationNode,
  HlslDocumentNode,
  HlslFunctionNode,
  HlslIncludeNode,
  HlslMacroNode,
  HlslStructNode,
  HlslVariableNode,
  ParsedDocument,
  ShaderDocumentNode,
  ShaderHlslBlockNode,
  ShaderPassNode,
  ShaderPropertyNode,
  ShaderSubShaderNode,
} from '../parser/ast';

import { ShaderSymbol, SymbolKind } from './symbol';

export class SymbolExtractor {
  public extract(document: ParsedDocument): ShaderSymbol[] {
    if (document.languageId === 'shaderlab') {
      return this.extractShaderDocument(document);
    }

    return this.extractHlslDocument(document);
  }

  private extractShaderDocument(document: ParsedDocument): ShaderSymbol[] {
    const ast = document.ast as ShaderDocumentNode;

    const result: ShaderSymbol[] = [];

    /*
     * Shader
     */
    if (ast.shaderName) {
      result.push(this.createSymbol(ast.shaderName, 'shader', ast.shaderName, document.uri));
    }

    /*
     * Properties
     */
    for (const property of ast.properties) {
      result.push(this.extractProperty(property, document.uri));
    }

    /*
     * SubShaders
     */
    for (const subShader of ast.subShaders) {
      result.push(this.extractSubShader(subShader, document.uri));
    }

    /*
     * Shader-level HLSL blocks
     *
     * ShaderDocumentNode.hlslBlocks
     */
    for (const block of ast.hlslBlocks) {
      result.push(...this.extractHlslBlock(block, document.uri));
    }

    return result;
  }

  private extractProperty(property: ShaderPropertyNode, uri: string): ShaderSymbol {
    return {
      name: property.name,
      kind: 'property',
      location: {
        uri,
        range: property.range,
        selectionRange: property.range,
      },
      children: [],
    };
  }

  private extractSubShader(subShader: ShaderSubShaderNode, uri: string): ShaderSymbol {
    const children: ShaderSymbol[] = [];

    /*
     * SubShader 内の HLSL
     */
    for (const block of subShader.hlslBlocks) {
      children.push(...this.extractHlslBlock(block, uri));
    }

    /*
     * Pass
     */
    for (const pass of subShader.passes) {
      children.push(this.extractPass(pass, uri));
    }

    return {
      name: this.getSubShaderName(subShader),
      kind: 'subShader',
      location: {
        uri,
        range: subShader.range,
        selectionRange: subShader.range,
      },
      children,
    };
  }

  private extractPass(pass: ShaderPassNode, uri: string): ShaderSymbol {
    const children: ShaderSymbol[] = [];

    /*
     * Pass 内の HLSLPROGRAM / HLSLINCLUDE
     */
    for (const block of pass.hlslBlocks) {
      children.push(...this.extractHlslBlock(block, uri));
    }

    return {
      name: pass.name ?? 'Pass',
      kind: 'pass',
      location: {
        uri,
        range: pass.range,
        selectionRange: pass.range,
      },
      children,
    };
  }

  private extractHlslBlock(block: ShaderHlslBlockNode, uri: string): ShaderSymbol[] {
    if (!block.hlsl) {
      return [];
    }

    return this.extractHlslDocument({
      uri,
      languageId: 'hlsl',
      version: 0,
      ast: block.hlsl,
    });
  }

  private extractHlslDocument(document: ParsedDocument): ShaderSymbol[] {
    const ast = document.ast as HlslDocumentNode;

    const result: ShaderSymbol[] = [];

    for (const declaration of ast.declarations) {
      const symbol = this.extractHlslDeclaration(declaration, document.uri);

      if (symbol) {
        result.push(symbol);
      }
    }

    return result;
  }

  private extractHlslDeclaration(declaration: HlslDeclarationNode, uri: string): ShaderSymbol | undefined {
    switch (declaration.kind) {
      case 'HlslStruct':
        return this.extractStruct(declaration, uri);

      case 'HlslFunction':
        return this.extractFunction(declaration, uri);

      case 'HlslVariable':
        return this.extractVariable(declaration, uri);

      case 'HlslCBuffer':
        return this.extractCBuffer(declaration, uri);

      case 'HlslMacro':
        return this.extractMacro(declaration, uri);

      case 'HlslInclude':
        return this.extractInclude(declaration, uri);

      default:
        return undefined;
    }
  }

  private extractStruct(node: HlslStructNode, uri: string): ShaderSymbol {
    const children: ShaderSymbol[] = [];

    for (const field of node.fields) {
      children.push({
        name: field.name,
        kind: 'field',
        location: {
          uri,
          range: field.range,
          selectionRange: field.range,
        },
        typeName: field.typeName,
        semantic: field.semantic,
        parentName: node.name,
        children: [],
      });
    }

    return {
      name: node.name,
      kind: 'struct',
      location: {
        uri,
        range: node.range,
        selectionRange: node.range,
      },
      children,
    };
  }

  private extractFunction(node: HlslFunctionNode, uri: string): ShaderSymbol {
    const children: ShaderSymbol[] = [];

    for (const parameter of node.parameters) {
      children.push({
        name: parameter.name,
        kind: 'parameter',
        location: {
          uri,
          range: parameter.range,
          selectionRange: parameter.range,
        },
        typeName: parameter.typeName,
        semantic: parameter.semantic,
        parentName: node.name,
        children: [],
      });
    }

    return {
      name: node.name,
      kind: 'function',
      location: {
        uri,
        range: node.range,
        selectionRange: node.range,
      },
      returnType: node.returnType,
      children,
    };
  }

  private extractVariable(node: HlslVariableNode, uri: string): ShaderSymbol {
    return {
      name: node.name,
      kind: 'variable',
      location: {
        uri,
        range: node.range,
        selectionRange: node.range,
      },
      typeName: node.typeName,
      semantic: node.semantic,
      children: [],
    };
  }

  private extractCBuffer(node: HlslCBufferNode, uri: string): ShaderSymbol {
    const children: ShaderSymbol[] = [];

    for (const field of node.fields) {
      children.push({
        name: field.name,
        kind: 'field',
        location: {
          uri,
          range: field.range,
          selectionRange: field.range,
        },
        typeName: field.typeName,
        semantic: field.semantic,
        parentName: node.name,
        children: [],
      });
    }

    return {
      name: node.name,
      kind: 'cbuffer',
      location: {
        uri,
        range: node.range,
        selectionRange: node.range,
      },
      children,
    };
  }

  private extractMacro(node: HlslMacroNode, uri: string): ShaderSymbol {
    return {
      name: node.name,
      kind: 'macro',
      location: {
        uri,
        range: node.range,
        selectionRange: node.range,
      },
      children: [],
    };
  }

  private extractInclude(node: HlslIncludeNode, uri: string): ShaderSymbol {
    return {
      name: node.path,
      kind: 'include',
      location: {
        uri,
        range: node.range,
        selectionRange: node.range,
      },
      children: [],
    };
  }

  private getSubShaderName(subShader: ShaderSubShaderNode): string {
    return 'SubShader';
  }

  private createSymbol(name: string, kind: SymbolKind, range: any, uri: string): ShaderSymbol {
    return {
      name,
      kind,
      location: {
        uri,
        range,
        selectionRange: range,
      },
      children: [],
    };
  }
}
