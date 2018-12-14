/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as Json from 'jsonc-parser';
import { JSONSchema, JSONSchemaRef } from '../jsonSchema';
import { isNumber, equals, isBoolean, isString, isDefined } from '../utils/objects';
import { ASTNode, ObjectASTNode, ArrayASTNode, BooleanASTNode, NumberASTNode, StringASTNode, NullASTNode, PropertyASTNode, JSONPath, ErrorCode } from '../jsonLanguageTypes';

import * as nls from 'vscode-nls';
import Uri from 'vscode-uri';
import { TextDocument, Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';

const localize = nls.loadMessageBundle();

export interface IRange {
  offset: number;
  length: number;
}

const colorHexPattern = /^#([0-9A-Fa-f]{3,4}|([0-9A-Fa-f]{2}){3,4})$/;
const emailPattern = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

export interface IProblem {
  location: IRange;
  severity: DiagnosticSeverity;
  code?: ErrorCode;
  message: string;
}

export abstract class ASTNodeImpl {

  public readonly abstract type: 'object' | 'property' | 'array' | 'number' | 'boolean' | 'null' | 'string';

  public offset: number;
  public length: number;
  public readonly parent: ASTNode;

  constructor(parent: ASTNode, offset: number, length?: number) {
    this.offset = offset;
    this.length = length || 0;
    this.parent = parent;
  }

  public get children(): ASTNode[] {
    return [];
  }

  public toString(): string {
    return 'type: ' + this.type + ' (' + this.offset + '/' + this.length + ')' + (this.parent ? ' parent: {' + this.parent.toString() + '}' : '');
  }
}

export class NullASTNodeImpl extends ASTNodeImpl implements NullASTNode {

  public type: 'null' = 'null';
  public value: null = null;
  constructor(parent: ASTNode, offset: number, length?: number) {
    super(parent, offset, length);
  }
}

export class BooleanASTNodeImpl extends ASTNodeImpl implements BooleanASTNode {

  public type: 'boolean' = 'boolean';
  public value: boolean;

  constructor(parent: ASTNode, boolValue: boolean, offset: number, length?: number) {
    super(parent, offset, length);
    this.value = boolValue;
  }
}

export class ArrayASTNodeImpl extends ASTNodeImpl implements ArrayASTNode {

  public type: 'array' = 'array';
  public items: ASTNode[];

  constructor(parent: ASTNode, offset: number, length?: number) {
    super(parent, offset, length);
    this.items = [];
  }

  public get children(): ASTNode[] {
    return this.items;
  }
}

export class NumberASTNodeImpl extends ASTNodeImpl implements NumberASTNode {

  public type: 'number' = 'number';
  public isInteger: boolean;
  public value: number;

  constructor(parent: ASTNode, offset: number, length?: number) {
    super(parent, offset, length);
    this.isInteger = true;
    this.value = Number.NaN;
  }
}

export class StringASTNodeImpl extends ASTNodeImpl implements StringASTNode {
  public type: 'string' = 'string';
  public value: string;

  constructor(parent: ASTNode, offset: number, length?: number) {
    super(parent, offset, length);
    this.value = '';
  }
}

export class PropertyASTNodeImpl extends ASTNodeImpl implements PropertyASTNode {
  public type: 'property' = 'property';
  public keyNode: StringASTNode;
  public valueNode: ASTNode;
  public colonOffset: number;

  constructor(parent: ObjectASTNode, offset: number, length?: number) {
    super(parent, offset, length);
    this.colonOffset = -1;
  }

  public get children(): ASTNode[] {
    return this.valueNode ? [this.keyNode, this.valueNode] : [this.keyNode];
  }
}

export class ObjectASTNodeImpl extends ASTNodeImpl implements ObjectASTNode {
  public type: 'object' = 'object';
  public properties: PropertyASTNode[];

  constructor(parent: ASTNode, offset: number, length?: number) {
    super(parent, offset, length);

    this.properties = [];
  }

  public get children(): ASTNode[] {
    return this.properties;
  }

}

export function asSchema(schema: JSONSchemaRef) {
  if (isBoolean(schema)) {
    return schema ? {} : { "not": {} };
  }
  return schema;
}

export interface JSONDocumentConfig {
  collectComments?: boolean;
}

export interface IApplicableSchema {
  node: ASTNode;
  inverted?: boolean;
  schema: JSONSchema;
}

export enum EnumMatch {
  Key, Enum
}

export interface ISchemaCollector {
  schemas: IApplicableSchema[];
  add(schema: IApplicableSchema): void;
  merge(other: ISchemaCollector): void;
  include(node: ASTNode): boolean;
  newSub(): ISchemaCollector;
}

class SchemaCollector implements ISchemaCollector {
  schemas: IApplicableSchema[] = [];
  constructor(private focusOffset = -1, private exclude: ASTNode = null) {
  }
  add(schema: IApplicableSchema) {
    this.schemas.push(schema);
  }
  merge(other: ISchemaCollector) {
    this.schemas.push(...other.schemas);
  }
  include(node: ASTNode) {
    return (this.focusOffset === -1 || contains(node, this.focusOffset)) && (node !== this.exclude);
  }
  newSub(): ISchemaCollector {
    return new SchemaCollector(-1, this.exclude);
  }
}

class NoOpSchemaCollector implements ISchemaCollector {
  private constructor() { }
  get schemas() { return []; }
  add(schema: IApplicableSchema) { }
  merge(other: ISchemaCollector) { }
  include(node: ASTNode) { return true; }
  newSub(): ISchemaCollector { return this; }

  static instance = new NoOpSchemaCollector();
}

export class ValidationResult {
  public problems: IProblem[];

  public propertiesMatches: number;
  public propertiesValueMatches: number;
  public primaryValueMatches: number;
  public enumValueMatch: boolean;
  public enumValues: any[];

  constructor() {
    this.problems = [];
    this.propertiesMatches = 0;
    this.propertiesValueMatches = 0;
    this.primaryValueMatches = 0;
    this.enumValueMatch = false;
    this.enumValues = null;
  }

  public hasProblems(): boolean {
    return !!this.problems.length;
  }

  public mergeAll(validationResults: ValidationResult[]): void {
    for (const validationResult of validationResults) {
      this.merge(validationResult);
    }
  }

  public merge(validationResult: ValidationResult): void {
    this.problems = this.problems.concat(validationResult.problems);
  }

  public mergeEnumValues(validationResult: ValidationResult): void {
    if (!this.enumValueMatch && !validationResult.enumValueMatch && this.enumValues && validationResult.enumValues) {
      this.enumValues = this.enumValues.concat(validationResult.enumValues);
      for (let error of this.problems) {
        if (error.code === ErrorCode.EnumValueMismatch) {
          error.message = localize('enumWarning', 'Value is not accepted. Valid values: {0}.', this.enumValues.map(v => JSON.stringify(v)).join(', '));
        }
      }
    }
  }

  public mergePropertyMatch(propertyValidationResult: ValidationResult): void {
    this.merge(propertyValidationResult);
    this.propertiesMatches++;
    if (propertyValidationResult.enumValueMatch || !propertyValidationResult.hasProblems() && propertyValidationResult.propertiesMatches) {
      this.propertiesValueMatches++;
    }
    if (propertyValidationResult.enumValueMatch && propertyValidationResult.enumValues && propertyValidationResult.enumValues.length === 1) {
      this.primaryValueMatches++;
    }
  }

  public compare(other: ValidationResult): number {
    let hasProblems = this.hasProblems();
    if (hasProblems !== other.hasProblems()) {
      return hasProblems ? -1 : 1;
    }
    if (this.enumValueMatch !== other.enumValueMatch) {
      return other.enumValueMatch ? -1 : 1;
    }
    if (this.primaryValueMatches !== other.primaryValueMatches) {
      return this.primaryValueMatches - other.primaryValueMatches;
    }
    if (this.propertiesValueMatches !== other.propertiesValueMatches) {
      return this.propertiesValueMatches - other.propertiesValueMatches;
    }
    return this.propertiesMatches - other.propertiesMatches;
  }

}

export function newJSONDocument(root: ASTNode, diagnostics: Diagnostic[] = []) {
  return new JSONDocument(root, diagnostics, []);
}

export function getNodeValue(node: ASTNode): any {
  return Json.getNodeValue(node);
}

export function getNodePath(node: ASTNode): JSONPath {
  return Json.getNodePath(node);
}

export function contains(node: ASTNode, offset: number, includeRightBound = false): boolean {
  return offset >= node.offset && offset < (node.offset + node.length) || includeRightBound && offset === (node.offset + node.length);
}

// export function contains(node: ASTNode, offset: number, includeRightBound = false): boolean {
//   let flag = offset >= node.offset && offset <= (node.offset + node.length);
//   if (!flag && includeRightBound) {
//     if (node.parent && node.parent.children && )
//     const nextSibling = node.parent
//   }
//   return flag;
// }

// export function findNodeAtOffset(node: ASTNode, offset: number, includeRightBound = false): ASTNode | undefined {
//   if (contains(node, offset, includeRightBound)) {
//     const children = node.children;
//     if (Array.isArray(children)) {
//       for (var i = 0; i < children.length && children[i].offset <= offset; i++) {
//         const item = findNodeAtOffset(children[i], offset, includeRightBound);
//         if (item) {
//           return item;
//         }
//       }
//     }
//     return node;
//   }
// }

export class JSONDocument {

  constructor(public root: ASTNode, public readonly syntaxErrors: Diagnostic[] = [], public readonly comments: Range[] = []) {
  }

  public getNodeFromOffset(offset: number, includeRightBound = false): ASTNode | undefined {
    if (this.root) {
      return <ASTNode>Json.findNodeAtOffset(this.root, offset, includeRightBound);
      //return findNodeAtOffset(this.root, offset, includeRightBound);
    }
    return void 0;
  }

  public visit(visitor: (node: ASTNode) => boolean): void {
    if (this.root) {
      let doVisit = (node: ASTNode): boolean => {
        let ctn = visitor(node);
        let children = node.children;
        if (Array.isArray(children)) {
          for (let i = 0; i < children.length && ctn; i++) {
            ctn = doVisit(children[i]);
          }
        }
        return ctn;
      };
      doVisit(this.root);
    }
  }

  public validate(textDocument: TextDocument, schema: JSONSchema): Diagnostic[] {
    if (this.root && schema) {
      let validationResult = new ValidationResult();
      validate(this.root, schema, validationResult, NoOpSchemaCollector.instance);
      return validationResult.problems.map(p => {
        let range = Range.create(textDocument.positionAt(p.location.offset), textDocument.positionAt(p.location.offset + p.location.length));
        return Diagnostic.create(range, p.message, p.severity, p.code);
      });
    }
    return null;
  }

  public getMatchingSchemas(schema: JSONSchema, focusOffset: number = -1, exclude: ASTNode = null): IApplicableSchema[] {
    let matchingSchemas = new SchemaCollector(focusOffset, exclude);
    if (this.root && schema) {
      validate(this.root, schema, new ValidationResult(), matchingSchemas);
    }
    return matchingSchemas.schemas;
  }
}

function validate(node: ASTNode, schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector) {

  if (!node || !matchingSchemas.include(node)) {
    return;
  }

  switch (node.type) {
    case 'object':
      _validateObjectNode(node, schema, validationResult, matchingSchemas);
      break;
    case 'array':
      _validateArrayNode(node, schema, validationResult, matchingSchemas);
      break;
    case 'string':
      _validateStringNode(node, schema, validationResult, matchingSchemas);
      break;
    case 'number':
      _validateNumberNode(node, schema, validationResult, matchingSchemas);
      break;
    case 'property':
      return validate(node.valueNode, schema, validationResult, matchingSchemas);
  }
  _validateNode();

  matchingSchemas.add({ node: node, schema: schema });

  function _validateNode() {

    function matchesType(type: string) {
      return node.type === type || (type === 'integer' && node.type === 'number' && node.isInteger);
    }

    if (Array.isArray(schema.type)) {
      if (!schema.type.some(matchesType)) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.errorMessage || localize('typeArrayMismatchWarning', 'Incorrect type. Expected one of {0}.', (<string[]>schema.type).join(', '))
        });
      }
    }
    else if (schema.type) {
      if (!matchesType(schema.type)) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.errorMessage || localize('typeMismatchWarning', 'Incorrect type. Expected "{0}".', schema.type)
        });
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const subSchemaRef of schema.allOf) {
        validate(node, asSchema(subSchemaRef), validationResult, matchingSchemas);
      }
    }
    let notSchema = asSchema(schema.not);
    if (notSchema) {
      let subValidationResult = new ValidationResult();
      let subMatchingSchemas = matchingSchemas.newSub();
      validate(node, notSchema, subValidationResult, subMatchingSchemas);
      if (!subValidationResult.hasProblems()) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: localize('notSchemaWarning', "Matches a schema that is not allowed.")
        });
      }
      for (const ms of subMatchingSchemas.schemas) {
        ms.inverted = !ms.inverted;
        matchingSchemas.add(ms);
      }
    }

    let testAlternatives = (alternatives: JSONSchemaRef[], maxOneMatch: boolean) => {
      let matches = [];

      // remember the best match that is used for error messages
      let bestMatch: { schema: JSONSchema; validationResult: ValidationResult; matchingSchemas: ISchemaCollector; } = null;
      for (const subSchemaRef of alternatives) {
        let subSchema = asSchema(subSchemaRef);
        let subValidationResult = new ValidationResult();
        let subMatchingSchemas = matchingSchemas.newSub();
        validate(node, subSchema, subValidationResult, subMatchingSchemas);
        if (!subValidationResult.hasProblems()) {
          matches.push(subSchema);
        }
        if (!bestMatch) {
          bestMatch = { schema: subSchema, validationResult: subValidationResult, matchingSchemas: subMatchingSchemas };
        } else {
          if (!maxOneMatch && !subValidationResult.hasProblems() && !bestMatch.validationResult.hasProblems()) {
            // no errors, both are equally good matches
            bestMatch.matchingSchemas.merge(subMatchingSchemas);
            bestMatch.validationResult.propertiesMatches += subValidationResult.propertiesMatches;
            bestMatch.validationResult.propertiesValueMatches += subValidationResult.propertiesValueMatches;
          } else {
            let compareResult = subValidationResult.compare(bestMatch.validationResult);
            if (compareResult > 0) {
              // our node is the best matching so far
              bestMatch = { schema: subSchema, validationResult: subValidationResult, matchingSchemas: subMatchingSchemas };
            } else if (compareResult === 0) {
              // there's already a best matching but we are as good
              bestMatch.matchingSchemas.merge(subMatchingSchemas);
              bestMatch.validationResult.mergeEnumValues(subValidationResult);
            }
          }
        }
      }

      if (matches.length > 1 && maxOneMatch) {
        validationResult.problems.push({
          location: { offset: node.offset, length: 1 },
          severity: DiagnosticSeverity.Warning,
          message: localize('oneOfWarning', "Matches multiple schemas when only one must validate.")
        });
      }
      if (bestMatch !== null) {
        validationResult.merge(bestMatch.validationResult);
        validationResult.propertiesMatches += bestMatch.validationResult.propertiesMatches;
        validationResult.propertiesValueMatches += bestMatch.validationResult.propertiesValueMatches;
        matchingSchemas.merge(bestMatch.matchingSchemas);
      }
      return matches.length;
    };
    if (Array.isArray(schema.anyOf)) {
      testAlternatives(schema.anyOf, false);
    }
    if (Array.isArray(schema.oneOf)) {
      testAlternatives(schema.oneOf, true);
    }

    let testBranch = (schema: JSONSchemaRef) => {
      let subValidationResult = new ValidationResult();
      let subMatchingSchemas = matchingSchemas.newSub();

      validate(node, asSchema(schema), subValidationResult, subMatchingSchemas);

      validationResult.merge(subValidationResult);
      validationResult.propertiesMatches += subValidationResult.propertiesMatches;
      validationResult.propertiesValueMatches += subValidationResult.propertiesValueMatches;
      matchingSchemas.merge(subMatchingSchemas);
    };

    let testCondition = (ifSchema: JSONSchemaRef, thenSchema?: JSONSchemaRef, elseSchema?: JSONSchemaRef) => {
      let subSchema = asSchema(ifSchema);
      let subValidationResult = new ValidationResult();
      let subMatchingSchemas = matchingSchemas.newSub();

      validate(node, subSchema, subValidationResult, subMatchingSchemas);
      matchingSchemas.merge(subMatchingSchemas);

      if (!subValidationResult.hasProblems()) {
        if (thenSchema) {
          testBranch(thenSchema);
        }
      } else if (elseSchema) {
        testBranch(elseSchema);
      }
    };

    let ifSchema = asSchema(schema.if);
    if (ifSchema) {
      testCondition(ifSchema, asSchema(schema.then), asSchema(schema.else));
    }

    if (Array.isArray(schema.enum)) {
      let val = getNodeValue(node);
      let enumValueMatch = false;
      for (let e of schema.enum) {
        if (equals(val, e)) {
          enumValueMatch = true;
          break;
        }
      }
      validationResult.enumValues = schema.enum;
      validationResult.enumValueMatch = enumValueMatch;
      if (!enumValueMatch) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          code: ErrorCode.EnumValueMismatch,
          message: schema.errorMessage || localize('enumWarning', 'Value is not accepted. Valid values: {0}.', schema.enum.map(v => JSON.stringify(v)).join(', '))
        });
      }
    }

    if (isDefined(schema.const)) {
      let val = getNodeValue(node);
      if (!equals(val, schema.const)) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          code: ErrorCode.EnumValueMismatch,
          message: schema.errorMessage || localize('constWarning', 'Value must be {0}.', JSON.stringify(schema.const))
        });
        validationResult.enumValueMatch = false;
      } else {
        validationResult.enumValueMatch = true;
      }
      validationResult.enumValues = [schema.const];
    }

    if (schema.deprecationMessage && node.parent) {
      validationResult.problems.push({
        location: { offset: node.parent.offset, length: node.parent.length },
        severity: DiagnosticSeverity.Warning,
        message: schema.deprecationMessage
      });
    }
  }



  function _validateNumberNode(node: NumberASTNode, schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
    let val = node.value;

    if (isNumber(schema.multipleOf)) {
      if (val % schema.multipleOf !== 0) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: localize('multipleOfWarning', 'Value is not divisible by {0}.', schema.multipleOf)
        });
      }
    }
    function getExclusiveLimit(limit: number | undefined, exclusive: boolean | number | undefined): number | undefined {
      if (isNumber(exclusive)) {
        return exclusive;
      }
      if (isBoolean(exclusive) && exclusive) {
        return limit;
      }
      return void 0;
    }
    function getLimit(limit: number | undefined, exclusive: boolean | number | undefined): number | undefined {
      if (!isBoolean(exclusive) || !exclusive) {
        return limit;
      }
      return void 0;
    }
    let exclusiveMinimum = getExclusiveLimit(schema.minimum, schema.exclusiveMinimum);
    if (isNumber(exclusiveMinimum) && val <= exclusiveMinimum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('exclusiveMinimumWarning', 'Value is below the exclusive minimum of {0}.', exclusiveMinimum)
      });
    }
    let exclusiveMaximum = getExclusiveLimit(schema.maximum, schema.exclusiveMaximum);
    if (isNumber(exclusiveMaximum) && val >= exclusiveMaximum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('exclusiveMaximumWarning', 'Value is above the exclusive maximum of {0}.', exclusiveMaximum)
      });
    }
    let minimum = getLimit(schema.minimum, schema.exclusiveMinimum);
    if (isNumber(minimum) && val < minimum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('minimumWarning', 'Value is below the minimum of {0}.', minimum)
      });
    }
    let maximum = getLimit(schema.maximum, schema.exclusiveMaximum);
    if (isNumber(maximum) && val > maximum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('maximumWarning', 'Value is above the maximum of {0}.', maximum)
      });
    }
  }

  function _validateStringNode(node: StringASTNode, schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
    if (isNumber(schema.minLength) && node.value.length < schema.minLength) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('minLengthWarning', 'String is shorter than the minimum length of {0}.', schema.minLength)
      });
    }

    if (isNumber(schema.maxLength) && node.value.length > schema.maxLength) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('maxLengthWarning', 'String is longer than the maximum length of {0}.', schema.maxLength)
      });
    }

    if (isString(schema.pattern)) {
      let regex = new RegExp(schema.pattern);
      if (!regex.test(node.value)) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.patternErrorMessage || schema.errorMessage || localize('patternWarning', 'String does not match the pattern of "{0}".', schema.pattern)
        });
      }
    }

    if (schema.format) {
      switch (schema.format) {
        case 'uri':
        case 'uri-reference': {
          let errorMessage;
          if (!node.value) {
            errorMessage = localize('uriEmpty', 'URI expected.');
          } else {
            try {
              let uri = Uri.parse(node.value);
              if (!uri.scheme && schema.format === 'uri') {
                errorMessage = localize('uriSchemeMissing', 'URI with a scheme is expected.');
              }
            } catch (e) {
              errorMessage = e.message;
            }
          }
          if (errorMessage) {
            validationResult.problems.push({
              location: { offset: node.offset, length: node.length },
              severity: DiagnosticSeverity.Warning,
              message: schema.patternErrorMessage || schema.errorMessage || localize('uriFormatWarning', 'String is not a URI: {0}', errorMessage)
            });
          }
        }
          break;
        case 'email': {
          if (!node.value.match(emailPattern)) {
            validationResult.problems.push({
              location: { offset: node.offset, length: node.length },
              severity: DiagnosticSeverity.Warning,
              message: schema.patternErrorMessage || schema.errorMessage || localize('emailFormatWarning', 'String is not an e-mail address.')
            });
          }
        }
          break;
        case 'color-hex': {
          if (!node.value.match(colorHexPattern)) {
            validationResult.problems.push({
              location: { offset: node.offset, length: node.length },
              severity: DiagnosticSeverity.Warning,
              message: schema.patternErrorMessage || schema.errorMessage || localize('colorHexFormatWarning', 'Invalid color format. Use #RGB, #RGBA, #RRGGBB or #RRGGBBAA.')
            });
          }
        }
          break;
        default:
      }
    }

  }
  function _validateArrayNode(node: ArrayASTNode, schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
    if (Array.isArray(schema.items)) {
      let subSchemas = schema.items;
      for (let index = 0; index < subSchemas.length; index++) {
        const subSchemaRef = subSchemas[index];
        let subSchema = asSchema(subSchemaRef);
        let itemValidationResult = new ValidationResult();
        let item = node.items[index];
        if (item) {
          validate(item, subSchema, itemValidationResult, matchingSchemas);
          validationResult.mergePropertyMatch(itemValidationResult);
        } else if (node.items.length >= subSchemas.length) {
          validationResult.propertiesValueMatches++;
        }
      }
      if (node.items.length > subSchemas.length) {
        if (typeof schema.additionalItems === 'object') {
          for (let i = subSchemas.length; i < node.items.length; i++) {
            let itemValidationResult = new ValidationResult();
            validate(node.items[i], <any>schema.additionalItems, itemValidationResult, matchingSchemas);
            validationResult.mergePropertyMatch(itemValidationResult);
          }
        } else if (schema.additionalItems === false) {
          validationResult.problems.push({
            location: { offset: node.offset, length: node.length },
            severity: DiagnosticSeverity.Warning,
            message: localize('additionalItemsWarning', 'Array has too many items according to schema. Expected {0} or fewer.', subSchemas.length)
          });
        }
      }
    } else {
      let itemSchema = asSchema(schema.items);
      if (itemSchema) {
        for (const item of node.items) {
          let itemValidationResult = new ValidationResult();
          validate(item, itemSchema, itemValidationResult, matchingSchemas);
          validationResult.mergePropertyMatch(itemValidationResult);
        }
      }
    }

    let containsSchema = asSchema(schema.contains);
    if (containsSchema) {
      let doesContain = node.items.some(item => {
        let itemValidationResult = new ValidationResult();
        validate(item, containsSchema, itemValidationResult, NoOpSchemaCollector.instance);
        return !itemValidationResult.hasProblems();
      });

      if (!doesContain) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.errorMessage || localize('requiredItemMissingWarning', 'Array does not contain required item.')
        });
      }
    }

    if (isNumber(schema.minItems) && node.items.length < schema.minItems) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('minItemsWarning', 'Array has too few items. Expected {0} or more.', schema.minItems)
      });
    }

    if (isNumber(schema.maxItems) && node.items.length > schema.maxItems) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: localize('maxItemsWarning', 'Array has too many items. Expected {0} or fewer.', schema.maxItems)
      });
    }

    if (schema.uniqueItems === true) {
      let values = getNodeValue(node);
      let duplicates = values.some((value, index) => {
        return index !== values.lastIndexOf(value);
      });
      if (duplicates) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: localize('uniqueItemsWarning', 'Array has duplicate items.')
        });
      }
    }

  }

  function _validateObjectNode(node: ObjectASTNode, schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
    let seenKeys: { [key: string]: ASTNode } = Object.create(null);
    let unprocessedProperties: string[] = [];
    for (const propertyNode of node.properties) {
      let key = propertyNode.keyNode.value;

      // TODO: see https://github.com/redhat-developer/vscode-yaml/issues/60
      // Replace the merge key with the actual values of what the node value points to in seen keys
      if (key === "<<" && propertyNode.valueNode) {
        switch (propertyNode.valueNode.type) {
          case "object": {
            propertyNode.value["properties"].forEach(propASTNode => {
              let propKey = propASTNode.key.value;
              seenKeys[propKey] = propASTNode.value;
              unprocessedProperties.push(propKey);
            });
            break;
          }
          case "array": {
            propertyNode.value["items"].forEach(sequenceNode => {
              sequenceNode["properties"].forEach(propASTNode => {
                let seqKey = propASTNode.key.value;
                seenKeys[seqKey] = propASTNode.value;
                unprocessedProperties.push(seqKey);
              });
            });
            break;
          }
          default: {
            break;
          }
        }
      } else {
        seenKeys[key] = propertyNode.valueNode;
        unprocessedProperties.push(key);
      }
    }

    if (Array.isArray(schema.required)) {
      for (const propertyName of schema.required) {
        if (!seenKeys[propertyName]) {
          let keyNode = node.parent && node.parent.type === 'property' && node.parent.keyNode;
          let location = keyNode ? { offset: keyNode.offset, length: keyNode.length } : { offset: node.offset, length: 1 };
          validationResult.problems.push({
            location: location,
            severity: DiagnosticSeverity.Warning,
            message: localize('MissingRequiredPropWarning', 'Missing property "{0}".', propertyName)
          });
        }
      }
    }

    let propertyProcessed = (prop: string) => {
      let index = unprocessedProperties.indexOf(prop);
      while (index >= 0) {
        unprocessedProperties.splice(index, 1);
        index = unprocessedProperties.indexOf(prop);
      }
    };

    if (schema.properties) {
      for (const propertyName of Object.keys(schema.properties)) {
        propertyProcessed(propertyName);
        let propertySchema = schema.properties[propertyName];
        let child = seenKeys[propertyName];
        if (child) {
          if (isBoolean(propertySchema)) {
            if (!propertySchema) {
              let propertyNode = <PropertyASTNode>child.parent;
              validationResult.problems.push({
                location: { offset: propertyNode.keyNode.offset, length: propertyNode.keyNode.length },
                severity: DiagnosticSeverity.Warning,
                message: schema.errorMessage || localize('DisallowedExtraPropWarning', 'Property {0} is not allowed.', propertyName)
              });
            } else {
              validationResult.propertiesMatches++;
              validationResult.propertiesValueMatches++;
            }
          } else {
            let propertyValidationResult = new ValidationResult();
            validate(child, propertySchema, propertyValidationResult, matchingSchemas);
            validationResult.mergePropertyMatch(propertyValidationResult);
          }
        }

      }
    }

    if (schema.patternProperties) {
      for (const propertyPattern of Object.keys(schema.patternProperties)) {
        let regex = new RegExp(propertyPattern);
        for (const propertyName of unprocessedProperties.slice(0)) {
          if (regex.test(propertyName)) {
            propertyProcessed(propertyName);
            let child = seenKeys[propertyName];
            if (child) {
              let propertySchema = schema.patternProperties[propertyPattern];
              if (isBoolean(propertySchema)) {
                if (!propertySchema) {
                  let propertyNode = <PropertyASTNode>child.parent;
                  validationResult.problems.push({
                    location: { offset: propertyNode.keyNode.offset, length: propertyNode.keyNode.length },
                    severity: DiagnosticSeverity.Warning,
                    message: schema.errorMessage || localize('DisallowedExtraPropWarning', 'Property {0} is not allowed.', propertyName)
                  });
                } else {
                  validationResult.propertiesMatches++;
                  validationResult.propertiesValueMatches++;
                }
              } else {
                let propertyValidationResult = new ValidationResult();
                validate(child, propertySchema, propertyValidationResult, matchingSchemas);
                validationResult.mergePropertyMatch(propertyValidationResult);
              }
            }
          }
        }
      }
    }

    if (typeof schema.additionalProperties === 'object') {
      for (const propertyName of unprocessedProperties) {
        let child = seenKeys[propertyName];
        if (child) {
          let propertyValidationResult = new ValidationResult();
          validate(child, <any>schema.additionalProperties, propertyValidationResult, matchingSchemas);
          validationResult.mergePropertyMatch(propertyValidationResult);
        }
      }
    } else if (schema.additionalProperties === false) {
      if (unprocessedProperties.length > 0) {
        for (const propertyName of unprocessedProperties) {
          let child = seenKeys[propertyName];
          if (child) {
            let propertyNode = <PropertyASTNode>child.parent;

            validationResult.problems.push({
              location: { offset: propertyNode.keyNode.offset, length: propertyNode.keyNode.length },
              severity: DiagnosticSeverity.Warning,
              message: schema.errorMessage || localize('DisallowedExtraPropWarning', 'Property {0} is not allowed.', propertyName)
            });
          }
        }
      }
    }

    if (isNumber(schema.maxProperties)) {
      if (node.properties.length > schema.maxProperties) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: localize('MaxPropWarning', 'Object has more properties than limit of {0}.', schema.maxProperties)
        });
      }
    }

    if (isNumber(schema.minProperties)) {
      if (node.properties.length < schema.minProperties) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: localize('MinPropWarning', 'Object has fewer properties than the required number of {0}', schema.minProperties)
        });
      }
    }

    if (schema.dependencies) {
      for (const key of Object.keys(schema.dependencies)) {
        let prop = seenKeys[key];
        if (prop) {
          let propertyDep = schema.dependencies[key];
          if (Array.isArray(propertyDep)) {
            for (const requiredProp of propertyDep) {
              if (!seenKeys[requiredProp]) {
                validationResult.problems.push({
                  location: { offset: node.offset, length: node.length },
                  severity: DiagnosticSeverity.Warning,
                  message: localize('RequiredDependentPropWarning', 'Object is missing property {0} required by property {1}.', requiredProp, key)
                });
              } else {
                validationResult.propertiesValueMatches++;
              }
            }
          } else {
            let propertySchema = asSchema(propertyDep);
            if (propertySchema) {
              let propertyValidationResult = new ValidationResult();
              validate(node, propertySchema, propertyValidationResult, matchingSchemas);
              validationResult.mergePropertyMatch(propertyValidationResult);
            }
          }
        }
      }
    }

    let propertyNames = asSchema(schema.propertyNames);
    if (propertyNames) {
      for (const f of node.properties) {
        let key = f.keyNode;
        if (key) {
          validate(key, propertyNames, validationResult, NoOpSchemaCollector.instance);
        }
      }
    }
  }
}
