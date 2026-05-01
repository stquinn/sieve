export interface HeuristicResult {
  tier: number
  language?: string
}

// ─── Go ──────────────────────────────────────────────────────────────────────
const GO_T1 = [
  /^package\s+\w+/m,
  /^type\s+\w+\s+struct\s*\{/m,
  /^type\s+\w+\s+interface\s*\{/m,
  /`(?:json|yaml|xml|db|bson|form|mapstructure|validate):"[^"]*"`/,
  /^import\s+\(/m,
  /^import\s+"/m,
]
const GO_T2 = [
  /\bfunc\s+\(\s*\w+\s+\*?\w+\s*\)\s+\w+\s*\(/,  // func (r *Recv) Method(
  /\bfunc\s+\w+\s*\(/,                              // func Name(
  /:=\s/,
  /^var\s+\w+\s+\w+/m,
  /^const\s+\w+/m,
  /\bfmt\.\w+\(/,
  /\berr\s*!=\s*nil\b/,
]

// ─── Java ────────────────────────────────────────────────────────────────────
const JAVA_T1 = [
  /^public\s+(?:class|interface|enum|abstract\s+class)\s+\w+/m,
  /^private\s+(?:class|interface|enum)\s+\w+/m,
  /^protected\s+(?:class|interface)\s+\w+/m,
  /\bpublic\s+static\s+void\s+main\s*\(\s*String/,
  /^import\s+java\./m,
  /^import\s+org\.\w+\.\w+/m,
  /^import\s+com\.\w+\.\w+/m,
]
const JAVA_T2 = [
  /@(?:Override|SpringBootApplication|Component|Service|Repository|Controller|Autowired|Bean|Test)\b/,
  /\bthrows\s+\w+(?:Exception|Error)\b/,
  /\bextends\s+\w+\b/,
  /\bimplements\s+\w+\b/,
  /\bSystem\.out\.print/,
  /new\s+\w+\(.*\);/,
  /\b(?:String|int|long|double|float|boolean|void|List|Map|Set)\s+\w+\s*=/,
]

// ─── Dart / Flutter ───────────────────────────────────────────────────────────
const DART_T1 = [
  /^import\s+'package:flutter\//m,        // Flutter widget import
  /^import\s+'dart:/m,                    // Dart core import
  /\bextends\s+(?:StatefulWidget|StatelessWidget|State)\b/,
  /Widget\s+build\s*\(\s*BuildContext/,   // build method
  /\brunApp\s*\(/,                         // runApp()
]
const DART_T2 = [
  /^import\s+'package:/m,                 // any pub package
  /\bScaffold\s*\(/,
  /\bContainer\s*\(/,
  /\bColumn\s*\(\s*children:/,
  /\bRow\s*\(\s*children:/,
  /@override\b/,                           // common in Dart
  /\bconst\s+\w+\s*\(/,                   // const constructors
  /\bfinal\s+\w+\s+\w+\s*=/,             // final typed fields
]

// ─── YAML ────────────────────────────────────────────────────────────────────
const YAML_K8S = /^apiVersion:\s*\S+[\s\S]+^kind:\s*[A-Za-z]+/m

function scoreYaml(text: string): number {
  const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
  if (lines.length === 0) return 0
  const kvLines = lines.filter(l => /^\s*[\w.-]+:\s*/.test(l)).length
  const listLines = lines.filter(l => /^\s*-\s+/.test(l)).length
  return (kvLines + listLines) / lines.length
}

// ─── Main detector ───────────────────────────────────────────────────────────
export function detectLanguage(text: string): HeuristicResult {
  const trimmed = text.trim()
  if (!trimmed) return { tier: 4 }

  // JSON
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try { JSON.parse(trimmed); return { tier: 1, language: 'json' } } catch {}
  }

  // YAML
  if (YAML_K8S.test(trimmed)) return { tier: 1, language: 'yaml' }
  const yamlScore = scoreYaml(trimmed)
  if (yamlScore >= 0.75 && trimmed.split('\n').length >= 3) {
    return { tier: yamlScore >= 0.9 ? 1 : 2, language: 'yaml' }
  }

  // Go tier 1
  if (GO_T1.some(re => re.test(trimmed))) return { tier: 1, language: 'go' }

  // Java tier 1
  if (JAVA_T1.some(re => re.test(trimmed))) return { tier: 1, language: 'java' }

  // Dart/Flutter tier 1
  if (DART_T1.some(re => re.test(trimmed))) return { tier: 1, language: 'dart' }

  // Go tier 2 (2+ signals)
  const goT2Hits = GO_T2.filter(re => re.test(trimmed)).length
  if (goT2Hits >= 2) return { tier: 2, language: 'go' }

  // Java tier 2 (2+ signals)
  const javaT2Hits = JAVA_T2.filter(re => re.test(trimmed)).length
  if (javaT2Hits >= 2) return { tier: 2, language: 'java' }

  // Dart tier 2 (2+ signals)
  const dartT2Hits = DART_T2.filter(re => re.test(trimmed)).length
  if (dartT2Hits >= 2) return { tier: 2, language: 'dart' }

  // TypeScript / JavaScript
  if (/^(?:export\s+)?interface\s+\w+/m.test(trimmed) || /^(?:export\s+)?type\s+\w+\s*=/m.test(trimmed)) {
    return { tier: 2, language: 'typescript' }
  }
  if (trimmed.includes('import ') && trimmed.includes('from ') && trimmed.includes('const ')) {
    return { tier: 2, language: 'typescript' }
  }
  if ((trimmed.includes('function(') || trimmed.includes('=>')) && trimmed.includes('const ')) {
    return { tier: 2, language: 'javascript' }
  }

  // Shell
  if (/^#!/.test(trimmed) && /bash|sh|zsh/i.test(trimmed.split('\n')[0])) {
    return { tier: 1, language: 'bash' }
  }

  // SQL
  if (/^SELECT\s/i.test(trimmed) && /\bFROM\b/i.test(trimmed)) {
    return { tier: 1, language: 'sql' }
  }

  // Python
  if (trimmed.includes('def ') && trimmed.includes('self')) return { tier: 1, language: 'python' }

  // Uncertain: multi-line structured code
  const lines = trimmed.split('\n')
  const braceCount = (trimmed.match(/[{}]/g) || []).length
  const semicolonCount = (trimmed.match(/;/g) || []).length
  const indentedLines = lines.filter(l => /^[ \t]{2,}/.test(l)).length
  const anyWeakSignal = goT2Hits >= 1 || javaT2Hits >= 1 || dartT2Hits >= 1
  if (lines.length > 2 && (braceCount > 2 || semicolonCount > 2 || anyWeakSignal || indentedLines > lines.length * 0.4)) {
    return { tier: 3 }
  }

  return { tier: 4 }
}
