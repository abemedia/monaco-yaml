import { type JSONSchema4, type JSONSchema6, type JSONSchema7 } from 'json-schema'
import {
  fromCodeActionContext,
  fromPosition,
  fromRange,
  toCodeAction,
  toCompletionList,
  toDocumentSymbol,
  toFoldingRange,
  toHover,
  toLink,
  toLocationLink,
  toMarkerData,
  toSelectionRanges,
  toTextEdit
} from 'monaco-languageserver-types'
import { registerMarkerDataProvider } from 'monaco-marker-data-provider'
import { type IDisposable, type MonacoEditor } from 'monaco-types'
import { createWorkerManager } from 'monaco-worker-manager'

import { type YAMLWorker } from './yaml.worker.js'

export interface SchemasSettings {
  /**
   * A `Uri` file match which will trigger the schema validation. This may be a glob or an exact
   * path.
   *
   * @example '.gitlab-ci.yml'
   * @example 'file://**\/.github/actions/*.yaml'
   */
  fileMatch: string[]

  /**
   * The JSON schema which will be used for validation. If not specified, it will be downloaded from
   * `uri`.
   */
  schema?: JSONSchema4 | JSONSchema6 | JSONSchema7

  /**
   * The source URI of the JSON schema. The JSON schema will be downloaded from here if no schema
   * was supplied. It will also be displayed as the source in hover tooltips.
   */
  uri: string
}

export interface MonacoYamlOptions {
  /**
   * If set, enable schema based autocompletion.
   *
   * @default true
   */
  readonly completion?: boolean

  /**
   * A list of custom tags.
   *
   * @default []
   */
  readonly customTags?: string[]

  /**
   * If set, the schema service will load schema content on-demand.
   *
   * @default false
   */
  readonly enableSchemaRequest?: boolean

  /**
   * If true, formatting using Prettier is enabled. Setting this to `false` does **not** exclude
   * Prettier from the bundle.
   *
   * @default true
   */
  readonly format?: boolean

  /**
   * If set, enable hover typs based the JSON schema.
   *
   * @default true
   */
  readonly hover?: boolean

  /**
   * If true, a different diffing algorithm is used to generate error messages.
   *
   * @default false
   */
  readonly isKubernetes?: boolean

  /**
   * A list of known schemas and/or associations of schemas to file names.
   *
   * @default []
   */
  readonly schemas?: SchemasSettings[]

  /**
   * If set, the validator will be enabled and perform syntax validation as well as schema
   * based validation.
   *
   * @default true
   */
  readonly validate?: boolean

  /**
   * The YAML version to use for parsing.
   *
   * @default '1.2'
   */
  readonly yamlVersion?: '1.1' | '1.2'
}

export interface MonacoYaml extends IDisposable {
  /**
   * Recondigure `monaco-yaml`.
   */
  update: (options: MonacoYamlOptions) => Promise<undefined>
}

/**
 * Configure `monaco-yaml`.
 *
 * > **Note**: There may only be one configured instance of `monaco-yaml` at a time.
 *
 * @param monaco
 *   The Monaco editor module. Typically you get this by importing `monaco-editor`. Third party
 *   integrations often expose it as the global `monaco` variable instead.
 * @param options
 *   Options to configure `monaco-yaml`
 * @returns
 *   A disposable object that can be used to update `monaco-yaml`
 */
export function configureMonacoYaml(monaco: MonacoEditor, options: MonacoYamlOptions): MonacoYaml {
  const createData: MonacoYamlOptions = {
    completion: true,
    customTags: [],
    enableSchemaRequest: false,
    format: true,
    isKubernetes: false,
    hover: true,
    schemas: [],
    validate: true,
    yamlVersion: '1.2',
    ...options
  }

  monaco.languages.register({
    id: 'yaml',
    extensions: ['.yaml', '.yml'],
    aliases: ['YAML', 'yaml', 'YML', 'yml'],
    mimetypes: ['application/x-yaml']
  })

  const workerManager = createWorkerManager<YAMLWorker, MonacoYamlOptions>(monaco, {
    label: 'yaml',
    moduleId: 'monaco-yaml/yaml.worker',
    createData
  })

  const markerDataProvider = registerMarkerDataProvider(monaco, 'yaml', {
    owner: 'yaml',

    async provideMarkerData(model) {
      const worker = await workerManager.getWorker(model.uri)
      const diagnostics = await worker.doValidation(String(model.uri))

      return diagnostics?.map((diagnostic) => toMarkerData(diagnostic))
    },

    async doReset(model) {
      const worker = await workerManager.getWorker(model.uri)
      await worker.resetSchema(String(model.uri))
    }
  })

  const disposables = [
    workerManager,
    markerDataProvider,

    monaco.languages.registerCompletionItemProvider('yaml', {
      triggerCharacters: [' ', ':'],

      async provideCompletionItems(model, position) {
        const wordInfo = model.getWordUntilPosition(position)
        const worker = await workerManager.getWorker(model.uri)
        const info = await worker.doComplete(String(model.uri), fromPosition(position))

        if (info) {
          return toCompletionList(info, {
            range: {
              startLineNumber: position.lineNumber,
              startColumn: wordInfo.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: wordInfo.endColumn
            }
          })
        }
      }
    }),

    monaco.languages.registerHoverProvider('yaml', {
      async provideHover(model, position) {
        const worker = await workerManager.getWorker(model.uri)
        const info = await worker.doHover(String(model.uri), fromPosition(position))

        if (info) {
          return toHover(info)
        }
      }
    }),

    monaco.languages.registerDefinitionProvider('yaml', {
      async provideDefinition(model, position) {
        const worker = await workerManager.getWorker(model.uri)
        const locationLinks = await worker.doDefinition(String(model.uri), fromPosition(position))

        return locationLinks?.map(toLocationLink)
      }
    }),

    monaco.languages.registerDocumentSymbolProvider('yaml', {
      displayName: 'yaml',

      async provideDocumentSymbols(model) {
        const worker = await workerManager.getWorker(model.uri)
        const items = await worker.findDocumentSymbols(String(model.uri))

        return items?.map(toDocumentSymbol)
      }
    }),

    monaco.languages.registerDocumentFormattingEditProvider('yaml', {
      displayName: 'yaml',

      async provideDocumentFormattingEdits(model) {
        const worker = await workerManager.getWorker(model.uri)
        const edits = await worker.format(String(model.uri))

        return edits?.map(toTextEdit)
      }
    }),

    monaco.languages.registerLinkProvider('yaml', {
      async provideLinks(model) {
        const worker = await workerManager.getWorker(model.uri)
        const links = await worker.findLinks(String(model.uri))

        if (links) {
          return {
            links: links.map(toLink)
          }
        }
      }
    }),

    monaco.languages.registerCodeActionProvider('yaml', {
      async provideCodeActions(model, range, context) {
        const worker = await workerManager.getWorker(model.uri)
        const codeActions = await worker.getCodeAction(
          String(model.uri),
          fromRange(range),
          fromCodeActionContext(context)
        )

        if (codeActions) {
          return {
            actions: codeActions.map((codeAction) => toCodeAction(codeAction)),
            dispose() {
              // This is required by the TypeScript interface, but it’s not implemented.
            }
          }
        }
      }
    }),

    monaco.languages.registerFoldingRangeProvider('yaml', {
      async provideFoldingRanges(model) {
        const worker = await workerManager.getWorker(model.uri)
        const foldingRanges = await worker.getFoldingRanges(String(model.uri))

        return foldingRanges?.map(toFoldingRange)
      }
    }),

    monaco.languages.setLanguageConfiguration('yaml', {
      comments: {
        lineComment: '#'
      },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" }
      ],
      surroundingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" }
      ],

      onEnterRules: [
        {
          beforeText: /:\s*$/,
          action: { indentAction: monaco.languages.IndentAction.Indent }
        }
      ]
    }),

    monaco.languages.registerSelectionRangeProvider('yaml', {
      async provideSelectionRanges(model, positions) {
        const worker = await workerManager.getWorker(model.uri)
        const selectionRanges = await worker.getSelectionRanges(
          String(model.uri),
          positions.map(fromPosition)
        )

        return selectionRanges?.map(toSelectionRanges)
      }
    })
  ]

  return {
    dispose() {
      for (const disposable of disposables) {
        disposable.dispose()
      }
    },

    async update(newOptions) {
      workerManager.updateCreateData(Object.assign(createData, newOptions))
      await markerDataProvider.revalidate()
    }
  }
}
