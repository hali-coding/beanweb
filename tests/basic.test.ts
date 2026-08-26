import { describe, expect, it } from 'vitest'
import { BasicError, Interpreter, build, recordingHost, tokenize } from '@/lib/basic'
import { parseExpression } from '@/lib/basic/parser'
import { formatNumber } from '@/lib/basic/values'

/**
 * The runtime is pure, so all of this runs with no DOM and no mocking: build a
 * program, hand it a recording host, assert on the call log.
 *
 * Note that error line numbers are *source rows*, not BASIC line numbers —
 * there are no line numbers any more, only optional labels.
 */

/** Run to completion under a step ceiling, so a runaway program fails the test
 *  rather than hanging the suite. */
function run(source: string, { steps = 40000 } = {}) {
  const host = recordingHost()
  const vm = new Interpreter(build(source), host)
  vm.start()
  let guard = 0
  while (vm.status === 'running' && guard < steps) {
    vm.runSlice({ maxSteps: 200 })
    guard += 200
  }
  return { vm, host, out: host.output() }
}

const outputOf = (source: string) => run(source).out
const trimmed = (source: string) => outputOf(source).trim()
/** Collapse the padding BASIC puts around numbers, for readable assertions. */
const words = (source: string) => outputOf(source).replace(/\s+/g, ' ').trim()

describe('tokenizer', () => {
  it('reads numbers, strings, names and operators', () => {
    const kinds = tokenize('PRINT "HI"; a$, n1 + 2.5').map((t) => `${t.kind}:${t.value}`)
    expect(kinds).toEqual([
      'keyword:PRINT',
      'string:HI',
      'op:;',
      'name:A$',
      'op:,',
      'name:N1',
      'op:+',
      'number:2.5',
      'eof:',
    ])
  })

  it('keeps type suffixes as part of the name', () => {
    expect(tokenize('a% a& a! a# a$').map((t) => t.value)).toEqual(['A%', 'A&', 'A!', 'A#', 'A$', ''])
  })

  it('treats newlines as statement separators', () => {
    const kinds = tokenize('CLS\nEND').map((t) => t.kind)
    expect(kinds).toEqual(['keyword', 'newline', 'keyword', 'eof'])
  })

  it('accepts both comment forms', () => {
    expect(tokenize("' hi there")[0]).toMatchObject({ kind: 'comment', value: 'hi there' })
    expect(tokenize('REM hi there')[0]).toMatchObject({ kind: 'comment', value: 'hi there' })
  })

  it('records the source row on every token', () => {
    const tokens = tokenize('CLS\nEND')
    expect(tokens.map((t) => t.line)).toEqual([1, 1, 2, 2])
  })

  it('records offsets, which the highlighter needs', () => {
    const [first] = tokenize('PRINT 1')
    expect(first).toMatchObject({ start: 0, end: 5, raw: 'PRINT' })
  })
})

describe('expression precedence', () => {
  const evaluate = (src: string) => trimmed(`PRINT ${src}`)

  it('multiplies before adding', () => {
    expect(evaluate('2 + 3 * 4')).toBe('14')
  })

  it('makes ^ bind tighter than unary minus', () => {
    expect(evaluate('-2 ^ 2')).toBe('-4')
  })

  it('makes ^ right-associative', () => {
    expect(evaluate('2 ^ 3 ^ 2')).toBe('512')
  })

  it('orders integer divide and MOD between * and +', () => {
    expect(evaluate('7 \\ 2')).toBe('3')
    expect(evaluate('7 MOD 2')).toBe('1')
    expect(evaluate('1 + 7 MOD 2')).toBe('2')
    // * binds tighter than \, so this is 7 \ 4, not (7 \ 2) * 2.
    expect(evaluate('7 \\ 2 * 2')).toBe('1')
  })

  it('puts NOT below the comparisons, as QBasic does', () => {
    // NOT a = b means NOT (a = b), which is the QBasic rule and the opposite
    // of what a C-shaped precedence would give.
    expect(evaluate('NOT 1 = 2')).toBe('-1')
    expect(evaluate('NOT 1 = 1')).toBe('0')
  })

  it('orders AND above OR', () => {
    expect(evaluate('0 AND 0 OR 1')).toBe('-1')
  })

  it('supports XOR', () => {
    expect(evaluate('1 XOR 0')).toBe('-1')
    expect(evaluate('1 XOR 1')).toBe('0')
  })

  it('honours parentheses', () => {
    expect(evaluate('(2 + 3) * 4')).toBe('20')
  })

  it('parses expressions standalone', () => {
    expect(parseExpression('1 + 2').kind).toBe('binary')
  })
})

describe('no line numbers required', () => {
  it('runs a bare program', () => {
    expect(trimmed('PRINT "HI"')).toBe('HI')
  })

  it('still accepts old line-numbered listings, treating numbers as labels', () => {
    expect(words('10 PRINT "A"\n20 PRINT "B"')).toBe('A B')
  })

  it('lets GOTO target a line number', () => {
    expect(trimmed('10 GOTO 30\n20 PRINT "NO"\n30 PRINT "YES"')).toBe('YES')
  })

  it('lets GOTO target a named label', () => {
    expect(trimmed('GOTO finish\nPRINT "NO"\nfinish:\nPRINT "YES"')).toBe('YES')
  })

  it('mixes both styles', () => {
    expect(trimmed('GOTO 20\nPRINT "NO"\n20 PRINT "YES"')).toBe('YES')
  })

  it('reports an undefined label', () => {
    expect(() => build('GOTO nowhere')).toThrow(/Label not defined/)
  })
})

describe('structured control flow', () => {
  it('runs a block IF with ELSEIF and ELSE', () => {
    const program = (n: number) => `
      x = ${n}
      IF x < 0 THEN
        PRINT "neg"
      ELSEIF x = 0 THEN
        PRINT "zero"
      ELSE
        PRINT "pos"
      END IF
    `
    expect(trimmed(program(-1))).toBe('neg')
    expect(trimmed(program(0))).toBe('zero')
    expect(trimmed(program(5))).toBe('pos')
  })

  it('still runs the single-line IF form', () => {
    expect(trimmed('IF 1 THEN PRINT "yes" ELSE PRINT "no"')).toBe('yes')
    expect(trimmed('IF 0 THEN PRINT "yes" ELSE PRINT "no"')).toBe('no')
  })

  it('runs DO WHILE with the test at the top', () => {
    expect(words('i = 0\nDO WHILE i < 3\n  PRINT i;\n  i = i + 1\nLOOP')).toBe('0 1 2')
  })

  it('runs DO UNTIL', () => {
    expect(words('i = 0\nDO UNTIL i = 3\n  PRINT i;\n  i = i + 1\nLOOP')).toBe('0 1 2')
  })

  it('runs LOOP WHILE, which always executes the body once', () => {
    // The distinguishing case: the condition is false from the start.
    expect(words('i = 9\nDO\n  PRINT i;\n  i = i + 1\nLOOP WHILE i < 3')).toBe('9')
  })

  it('runs LOOP UNTIL', () => {
    expect(words('i = 0\nDO\n  PRINT i;\n  i = i + 1\nLOOP UNTIL i = 3')).toBe('0 1 2')
  })

  it('runs WHILE / WEND', () => {
    expect(words('i = 0\nWHILE i < 3\n  PRINT i;\n  i = i + 1\nWEND')).toBe('0 1 2')
  })

  it('runs FOR / NEXT, including a negative STEP', () => {
    expect(words('FOR i = 1 TO 3\n PRINT i;\nNEXT i')).toBe('1 2 3')
    expect(words('FOR i = 3 TO 1 STEP -1\n PRINT i;\nNEXT')).toBe('3 2 1')
  })

  it('skips a FOR whose range is empty from the start', () => {
    expect(trimmed('FOR i = 5 TO 1\n PRINT "never"\nNEXT\nPRINT "after"')).toBe('after')
  })

  it('nests loops', () => {
    expect(words('FOR i = 1 TO 2\nFOR j = 1 TO 2\nPRINT i; j;\nNEXT j\nNEXT i'))
      .toBe('1 1 1 2 2 1 2 2')
  })

  it('leaves a loop early with EXIT FOR and EXIT DO', () => {
    expect(words('FOR i = 1 TO 9\n IF i = 3 THEN EXIT FOR\n PRINT i;\nNEXT')).toBe('1 2')
    expect(words('i = 0\nDO\n i = i + 1\n IF i = 3 THEN EXIT DO\n PRINT i;\nLOOP')).toBe('1 2')
  })

  it('exits only the innermost loop', () => {
    expect(words('FOR i = 1 TO 2\n FOR j = 1 TO 9\n  IF j = 2 THEN EXIT FOR\n  PRINT i; j;\n NEXT\nNEXT'))
      .toBe('1 1 2 1')
  })

  it('rejects EXIT FOR outside a loop', () => {
    expect(() => build('EXIT FOR')).toThrow(/outside a FOR loop/)
  })
})

describe('SELECT CASE', () => {
  const classify = (n: number) => trimmed(`
    SELECT CASE ${n}
      CASE 1
        PRINT "one"
      CASE 2, 3
        PRINT "two or three"
      CASE 4 TO 6
        PRINT "four to six"
      CASE IS >= 10
        PRINT "big"
      CASE ELSE
        PRINT "other"
    END SELECT
  `)

  it('matches a single value', () => expect(classify(1)).toBe('one'))
  it('matches a value list', () => expect(classify(3)).toBe('two or three'))
  it('matches a range', () => expect(classify(5)).toBe('four to six'))
  it('matches a comparison', () => expect(classify(99)).toBe('big'))
  it('falls through to CASE ELSE', () => expect(classify(8)).toBe('other'))

  it('matches strings', () => {
    expect(trimmed('SELECT CASE "b"\nCASE "a"\nPRINT 1\nCASE "b"\nPRINT 2\nEND SELECT')).toBe('2')
  })

  it('evaluates the subject only once', () => {
    // If the subject were re-evaluated per CASE, the counter would climb.
    const out = words(`
      FUNCTION Bump
        count = count + 1
        Bump = 5
      END FUNCTION
      DIM SHARED count
      SELECT CASE Bump
        CASE 1
        CASE 2
        CASE ELSE
      END SELECT
      PRINT count
    `)
    expect(out).toBe('1')
  })
})

describe('procedures', () => {
  it('calls a SUB with and without CALL', () => {
    const src = `
      Greet "world"
      CALL Greet("again")
      SUB Greet (who$)
        PRINT "hello "; who$
      END SUB
    `
    expect(outputOf(src).trim().split('\n')).toEqual(['hello world', 'hello again'])
  })

  it('returns a value from a FUNCTION', () => {
    expect(trimmed('PRINT Double(21)\nFUNCTION Double (n)\n Double = n * 2\nEND FUNCTION'))
      .toBe('42')
  })

  it('recurses', () => {
    const src = `
      FOR i = 1 TO 5
        PRINT Fact(i);
      NEXT i
      FUNCTION Fact (n)
        IF n <= 1 THEN
          Fact = 1
        ELSE
          Fact = n * Fact(n - 1)
        END IF
      END FUNCTION
    `
    expect(words(src)).toBe('1 2 6 24 120')
  })

  it('keeps procedure variables local', () => {
    const src = `
      x = 1
      Clobber
      PRINT x
      SUB Clobber
        x = 99
      END SUB
    `
    expect(trimmed(src)).toBe('1')
  })

  it('shares variables declared DIM SHARED', () => {
    const src = `
      DIM SHARED x
      x = 1
      Clobber
      PRINT x
      SUB Clobber
        x = 99
      END SUB
    `
    expect(trimmed(src)).toBe('99')
  })

  it('leaves a procedure early with EXIT SUB', () => {
    const src = `
      Test
      SUB Test
        PRINT "a"
        EXIT SUB
        PRINT "b"
      END SUB
    `
    expect(trimmed(src)).toBe('a')
  })

  it('reports the wrong number of arguments', () => {
    const { vm } = run('Greet\nSUB Greet (who$)\nPRINT who$\nEND SUB')
    expect(vm.error?.message).toMatch(/Wrong number of arguments/)
  })

  it('reports a call to something that does not exist', () => {
    const { vm } = run('CALL Nope')
    expect(vm.error?.message).toMatch(/Undefined procedure/)
  })

  it('bounds a runaway FUNCTION instead of hanging', () => {
    // Unbounded recursion must surface as an error, not a frozen tab.
    const { vm } = run('PRINT Spin(1)\nFUNCTION Spin (n)\n Spin = Spin(n + 1)\nEND FUNCTION')
    expect(vm.status).toBe('error')
    expect(vm.error?.message).toMatch(/ran too long|Maximum call stack/)
  })
})

describe('arrays', () => {
  it('dimensions and indexes an array', () => {
    expect(words('DIM a(5)\na(2) = 7\nPRINT a(2)')).toBe('7')
  })

  it('auto-dimensions an undeclared array to 10', () => {
    expect(words('b(3) = 4\nPRINT b(3)')).toBe('4')
  })

  it('handles two dimensions', () => {
    expect(words('DIM g(2, 3)\ng(1, 2) = 9\nPRINT g(1, 2)')).toBe('9')
  })

  it('holds strings', () => {
    expect(trimmed('DIM n$(3)\nn$(1) = "ada"\nPRINT n$(1)')).toBe('ada')
  })

  it('reports a subscript out of range', () => {
    const { vm } = run('DIM a(2)\na(9) = 1')
    expect(vm.error?.message).toMatch(/Subscript out of range/)
  })
})

describe('DATA, READ and RESTORE', () => {
  it('reads values in source order', () => {
    expect(words('DATA 1, 2, 3\nREAD a, b, c\nPRINT a; b; c')).toBe('1 2 3')
  })

  it('reads strings', () => {
    expect(trimmed('DATA "ada", "grace"\nREAD a$, b$\nPRINT a$; " "; b$')).toBe('ada grace')
  })

  it('sees DATA declared after the READ', () => {
    expect(words('READ x\nPRINT x\nDATA 42')).toBe('42')
  })

  it('rewinds with RESTORE', () => {
    expect(words('DATA 1, 2\nREAD a, b\nRESTORE\nREAD c\nPRINT a; b; c')).toBe('1 2 1')
  })

  it('reports running out of DATA', () => {
    const { vm } = run('DATA 1\nREAD a, b')
    expect(vm.error?.message).toMatch(/Out of DATA/)
  })
})

describe('builtins', () => {
  const evaluate = (src: string) => trimmed(`PRINT ${src}`)

  it('slices strings', () => {
    expect(evaluate('LEFT$("abcdef", 3)')).toBe('abc')
    expect(evaluate('RIGHT$("abcdef", 2)')).toBe('ef')
    expect(evaluate('MID$("abcdef", 2, 3)')).toBe('bcd')
    expect(evaluate('MID$("abcdef", 4)')).toBe('def')
  })

  it('returns empty rather than erroring past the end of a string', () => {
    expect(evaluate('MID$("abc", 9, 2)')).toBe('')
  })

  it('measures and converts', () => {
    expect(evaluate('LEN("hello")')).toBe('5')
    expect(evaluate('CHR$(65)')).toBe('A')
    expect(evaluate('ASC("A")')).toBe('65')
    expect(evaluate('VAL("12abc")')).toBe('12')
    expect(evaluate('VAL("nope")')).toBe('0')
    expect(evaluate('UCASE$("hi")')).toBe('HI')
    expect(evaluate('INSTR("hello", "ll")')).toBe('3')
    expect(evaluate('INSTR("hello", "z")')).toBe('0')
  })

  it('gives STR$ a leading sign-space but no trailing one', () => {
    // The trailing space belongs to PRINT, not to the string form.
    expect(outputOf('PRINT "[" + STR$(5) + "]"')).toBe('[ 5]\n')
  })

  it('does maths', () => {
    expect(evaluate('ABS(-3)')).toBe('3')
    expect(evaluate('INT(-2.5)')).toBe('-3')
    expect(evaluate('FIX(-2.5)')).toBe('-2')
    expect(evaluate('SGN(-9)')).toBe('-1')
    expect(evaluate('SQR(16)')).toBe('4')
  })

  it('reports a bad argument', () => {
    expect(run('PRINT SQR(-1)').vm.error?.message).toMatch(/Illegal function call/)
    expect(run('PRINT LEN(5)').vm.error?.message).toMatch(/Type mismatch/)
  })

  it('makes RND reproducible after RANDOMIZE with a fixed seed', () => {
    const once = words('RANDOMIZE 7\nFOR i = 1 TO 3\n PRINT INT(RND * 100);\nNEXT')
    const again = words('RANDOMIZE 7\nFOR i = 1 TO 3\n PRINT INT(RND * 100);\nNEXT')
    expect(once).toBe(again)
  })
})

describe('statements', () => {
  it('pads numbers with a leading sign-space and a trailing space', () => {
    expect(outputOf('PRINT 1;2')).toBe(' 1  2 \n')
    expect(outputOf('PRINT "a";"b"')).toBe('ab\n')
    expect(outputOf('PRINT -1;')).toBe('-1 ')
  })

  it('pads to the next zone for a comma', () => {
    expect(outputOf('PRINT "A","B"')).toMatch(/^A\s+B\n$/)
  })

  it('defaults unset variables to zero and empty string', () => {
    expect(words('PRINT z; "|"; z$')).toBe('0 |')
  })

  it('treats suffixed names as distinct variables', () => {
    expect(words('a% = 1\na$ = "x"\nPRINT a%; a$')).toBe('1 x')
  })

  it('runs several statements separated by colons', () => {
    expect(trimmed('a = 1 : a = a + 1 : PRINT a')).toBe('2')
  })

  it('swaps two variables', () => {
    expect(words('a = 1\nb = 2\nSWAP a, b\nPRINT a; b')).toBe('2 1')
  })

  it('declares constants', () => {
    expect(words('CONST pi = 3\nPRINT pi')).toBe('3')
  })

  it('runs GOSUB and RETURN', () => {
    // No space between the two: a trailing `;` suppresses the newline, and
    // strings carry none of the padding numbers get.
    expect(words('GOSUB sub1\nPRINT "back"\nEND\nsub1:\nPRINT "in";\nRETURN'))
      .toBe('inback')
  })

  it('reports RETURN without GOSUB', () => {
    expect(run('RETURN').vm.error?.message).toMatch(/RETURN without GOSUB/)
  })

  it('clears the screen with CLS', () => {
    expect(run('CLS').host.calls.some((c) => c.call === 'cls')).toBe(true)
  })

  it('stops at END, ignoring later statements', () => {
    expect(trimmed('PRINT "a"\nEND\nPRINT "b"')).toBe('a')
  })

  it('ignores comments in both forms', () => {
    expect(trimmed("' a comment\nPRINT \"x\" ' trailing\nREM another")).toBe('x')
  })
})

describe('errors', () => {
  it('reports division by zero against its source row', () => {
    const { vm } = run('PRINT "a"\nPRINT 1 / 0')
    expect(vm.status).toBe('error')
    expect(vm.error?.line).toBe(2)
    expect(vm.error?.message).toMatch(/Division by zero/)
  })

  it('reports integer divide and MOD by zero', () => {
    expect(run('PRINT 1 \\ 0').vm.error?.message).toMatch(/Division by zero/)
    expect(run('PRINT 1 MOD 0').vm.error?.message).toMatch(/Division by zero/)
  })

  it('tags a syntax error with its source row', () => {
    try {
      build('PRINT 1\nFOR = 3')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BasicError)
      expect((err as BasicError).line).toBe(2)
    }
  })

  it('reports a type mismatch on assignment', () => {
    expect(run('a = "text"').vm.error?.message).toMatch(/Type mismatch/)
  })

  it('reports comparing a string to a number', () => {
    expect(run('IF "a" = 1 THEN PRINT "x"').vm.error?.message).toMatch(/Type mismatch/)
  })

  it('formats the row into the message', () => {
    expect(new BasicError('?Broke', 40).toString()).toBe('?Broke in 40')
  })
})

describe('number formatting', () => {
  it('leads non-negative numbers with a space', () => {
    expect(formatNumber(5)).toBe(' 5')
    expect(formatNumber(-5)).toBe('-5')
  })

  it('does not leak float noise', () => {
    expect(formatNumber(0.1 + 0.2).trim()).toBe('0.3')
  })
})

describe('interruptibility', () => {
  it('does not hang on an empty infinite loop — it yields', () => {
    const vm = new Interpreter(build('DO\nLOOP'), recordingHost())
    vm.start()
    const status = vm.runSlice({ maxSteps: 500 })
    expect(status).toBe('running') // still going, but we got the thread back
    expect(vm.stepCount).toBe(500)
  })

  it('does not hang on GOTO to itself', () => {
    const vm = new Interpreter(build('top:\nGOTO top'), recordingHost())
    vm.start()
    expect(vm.runSlice({ maxSteps: 200 })).toBe('running')
  })

  it('stops between slices when asked', () => {
    const vm = new Interpreter(build('DO\nLOOP'), recordingHost())
    vm.start()
    vm.runSlice({ maxSteps: 50 })
    vm.stop()
    const before = vm.stepCount
    vm.runSlice({ maxSteps: 50 })
    expect(vm.status).toBe('done')
    expect(vm.stepCount).toBe(before)
  })

  it('honours a wall-clock budget using injected time', () => {
    let clock = 0
    const vm = new Interpreter(build('DO\nLOOP'), recordingHost(), () => {
      clock += 1
      return clock
    })
    vm.start()
    vm.runSlice({ budgetMs: 5 })
    expect(vm.status).toBe('running')
    expect(vm.stepCount).toBeLessThan(20)
  })

  it('completes a long loop across many slices', () => {
    expect(words('FOR i = 1 TO 500\nNEXT\nPRINT i')).toBe('501')
  })
})

describe('INPUT suspend and resume', () => {
  it('suspends, then resumes with the supplied value', () => {
    const host = recordingHost()
    const vm = new Interpreter(build('INPUT "NAME"; n$\nPRINT "HI "; n$'), host)
    vm.start()
    vm.runSlice({ maxSteps: 10 })

    expect(vm.status).toBe('awaiting-input')
    expect(vm.pendingInput?.prompt).toBe('NAME')

    vm.resumeInput('World')
    vm.runSlice({ maxSteps: 10 })
    expect(host.output().trim()).toBe('HI World')
  })

  it('fills several variables from one comma-separated reply', () => {
    const host = recordingHost()
    const vm = new Interpreter(build('INPUT a, b\nPRINT a + b'), host)
    vm.start()
    vm.runSlice({ maxSteps: 10 })
    vm.resumeInput('2, 3')
    vm.runSlice({ maxSteps: 10 })
    expect(host.output().trim()).toBe('5')
  })

  it('takes the whole reply for LINE INPUT, commas and all', () => {
    const host = recordingHost()
    const vm = new Interpreter(build('LINE INPUT a$\nPRINT a$'), host)
    vm.start()
    vm.runSlice({ maxSteps: 10 })
    vm.resumeInput('one, two')
    vm.runSlice({ maxSteps: 10 })
    expect(host.output().trim()).toBe('one, two')
  })

  it('treats unparseable numeric input as zero', () => {
    const host = recordingHost()
    const vm = new Interpreter(build('INPUT a\nPRINT a'), host)
    vm.start()
    vm.runSlice({ maxSteps: 10 })
    vm.resumeInput('not a number')
    vm.runSlice({ maxSteps: 10 })
    expect(host.output().trim()).toBe('0')
  })
})

describe('breakpoints', () => {
  it('pauses before the marked row runs', () => {
    const host = recordingHost()
    const vm = new Interpreter(build('PRINT "A"\nPRINT "B"\nPRINT "C"'), host)
    vm.breakpoints.add(2)
    vm.start()
    vm.runSlice({ maxSteps: 100 })

    expect(vm.status).toBe('ready')
    expect(vm.currentLine).toBe(2)
    expect(host.output()).toBe('A\n') // row 2 has not run yet
  })

  it('resumes past the breakpoint instead of re-triggering it', () => {
    const host = recordingHost()
    const vm = new Interpreter(build('PRINT "A"\nPRINT "B"'), host)
    vm.breakpoints.add(2)
    vm.start()
    vm.runSlice({ maxSteps: 100 })
    vm.resume()
    vm.runSlice({ maxSteps: 100 })
    expect(vm.status).toBe('done')
    expect(host.output()).toBe('A\nB\n')
  })

  it('steps one instruction at a time', () => {
    const host = recordingHost()
    const vm = new Interpreter(build('PRINT "A" : PRINT "B"'), host)
    vm.start()
    vm.step()
    expect(host.output()).toBe('A\n')
    vm.step()
    expect(host.output()).toBe('A\nB\n')
  })

  it('exposes live variables for a watch window', () => {
    const vm = new Interpreter(build('a = 7\nb$ = "x"'), recordingHost())
    vm.start()
    vm.runSlice({ maxSteps: 100 })
    expect(vm.variables().get('A')).toBe(7)
    expect(vm.variables().get('B$')).toBe('x')
  })
})
