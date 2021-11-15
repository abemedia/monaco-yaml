import './index.css';

import { JSONSchemaForSchemaStoreOrgCatalogFiles } from '@schemastore/schema-catalog';
import { CancellationToken } from 'monaco-editor/esm/vs/base/common/cancellation';
import { getDocumentSymbols } from 'monaco-editor/esm/vs/editor/contrib/documentSymbols/documentSymbols';
import {
  editor,
  Environment,
  languages,
  Position,
  Range,
  Uri,
} from 'monaco-editor/esm/vs/editor/editor.api';
import { SchemasSettings, setDiagnosticsOptions } from 'monaco-yaml';

// NOTE: This will give you all editor featues. If you would prefer to limit to only the editor
// features you want to use, import them each individually. See this example: (https://github.com/microsoft/monaco-editor-samples/blob/main/browser-esm-webpack-small/index.js#L1-L91)
import 'monaco-editor';

import defaultSchemaUri from './schema.json';

declare global {
  interface Window {
    MonacoEnvironment: Environment;
  }
}

window.MonacoEnvironment = {
  getWorker(moduleId, label) {
    switch (label) {
      case 'editorWorkerService':
        return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker', import.meta.url));
      case 'yaml':
        return new Worker(new URL('monaco-yaml/lib/esm/yaml.worker', import.meta.url));
      default:
        throw new Error(`Unknown label ${label}`);
    }
  },
};

const defaultSchema: SchemasSettings = {
  uri: defaultSchemaUri,
  fileMatch: ['monaco-yaml.yaml'],
};

setDiagnosticsOptions({
  schemas: [defaultSchema],
});

const value = `
# Property descriptions are displayed when hovering over properties using your cursor
property: This property has a JSON schema description


# Titles work too!
titledProperty: Titles work too!


# Even markdown descriptions work
markdown: hover me to get a markdown based description 😮


# Enums can be autocompleted by placing the cursor after the colon and pressing Ctrl+Space
enum:


# Of course numbers are supported!
number: 12


# As well as booleans!
boolean: true


# And strings
string: I am a string


# This property is using the JSON schema recursively
reference:
  boolean: Not a boolean


# Also works in arrays
array:
  - string: 12
    enum: Mewtwo
    reference:
      reference:
        boolean: true


# JSON referenses can be clicked for navigation
pointer:
  $ref: '#/array'


# This anchor can be referenced
anchorRef: &anchor can be clicked as well


# Press control while hovering over the anchor
anchorPointer: *anchor


formatting:       Formatting is supported too! Under the hood this is powered by Prettier. Just press Ctrl+Shift+I or right click and press Format to format this document.






`.replace(/:$/m, ': ');

const ed = editor.create(document.getElementById('editor'), {
  automaticLayout: true,
  model: editor.createModel(value, 'yaml', Uri.parse('monaco-yaml.yaml')),
  theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs-light',
});

const select = document.getElementById('schema-selection') as HTMLSelectElement;

fetch('https://www.schemastore.org/api/json/catalog.json').then(async (response) => {
  if (!response.ok) {
    return;
  }
  const catalog = (await response.json()) as JSONSchemaForSchemaStoreOrgCatalogFiles;
  const schemas = [defaultSchema];
  catalog.schemas.sort((a, b) => a.name.localeCompare(b.name));
  for (const { fileMatch, name, url } of catalog.schemas) {
    const match =
      typeof name === 'string' && fileMatch?.find((filename) => /\.ya?ml$/i.test(filename));
    if (!match) {
      continue;
    }
    const option = document.createElement('option');
    option.value = match;

    option.textContent = name;
    select.append(option);
    schemas.push({
      fileMatch: [match],
      uri: url,
    });
  }

  setDiagnosticsOptions({
    validate: true,
    enableSchemaRequest: true,
    format: true,
    hover: true,
    completion: true,
    schemas,
  });
});

select.addEventListener('change', () => {
  const oldModel = ed.getModel();
  const newModel = editor.createModel(oldModel.getValue(), 'yaml', Uri.parse(select.value));
  ed.setModel(newModel);
  oldModel.dispose();
});

function* iterateSymbols(
  symbols: languages.DocumentSymbol[],
  position: Position,
): Iterable<languages.DocumentSymbol> {
  for (const symbol of symbols) {
    if (Range.containsPosition(symbol.range, position)) {
      yield symbol;
      yield* iterateSymbols(symbol.children, position);
    }
  }
}

ed.onDidChangeCursorPosition(async (event) => {
  const breadcrumbs = document.getElementById('breadcrumbs');
  const symbols = await getDocumentSymbols(ed.getModel(), false, CancellationToken.None);
  while (breadcrumbs.lastChild) {
    breadcrumbs.lastChild.remove();
  }
  for (const symbol of iterateSymbols(symbols, event.position)) {
    const breadcrumb = document.createElement('span');
    breadcrumb.setAttribute('role', 'button');
    breadcrumb.classList.add('breadcrumb');
    breadcrumb.textContent = symbol.name;
    if (symbol.kind === languages.SymbolKind.Array) {
      breadcrumb.classList.add('array');
    } else if (symbol.kind === languages.SymbolKind.Module) {
      breadcrumb.classList.add('object');
    }
    breadcrumb.addEventListener('click', () => {
      ed.setPosition({
        lineNumber: symbol.range.startLineNumber,
        column: symbol.range.startColumn,
      });
      ed.focus();
    });
    breadcrumbs.append(breadcrumb);
  }
});

editor.onDidChangeMarkers(([resource]) => {
  const problems = document.getElementById('problems');
  const markers = editor.getModelMarkers({ resource });
  while (problems.lastChild) {
    problems.lastChild.remove();
  }
  for (const marker of markers) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'button');
    const codicon = document.createElement('div');
    const text = document.createElement('div');
    wrapper.classList.add('problem');
    codicon.classList.add('codicon', 'codicon-warning');
    text.classList.add('problem-text');
    text.textContent = marker.message;
    wrapper.append(codicon, text);
    wrapper.addEventListener('click', () => {
      ed.setPosition({ lineNumber: marker.startLineNumber, column: marker.startColumn });
      ed.focus();
    });
    problems.append(wrapper);
  }
});
