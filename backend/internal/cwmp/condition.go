package cwmp

import (
	"fmt"
	"regexp"
	"strings"
)

// ConditionOp is the type of a condition node.
type ConditionOp int

const (
	OpCompare ConditionOp = iota
	OpAnd
	OpOr
	OpNot
	OpHasTag
	OpNotHasTag
	OpExists
)

// CompareOp is the comparison operator.
type CompareOp int

const (
	CmpEq CompareOp = iota
	CmpNeq
	CmpGt
	CmpLt
	CmpGte
	CmpLte
	CmpContains
	CmpMatches
)

// Condition is a single node in the condition AST.
type Condition struct {
	Op       ConditionOp
	Compare  CompareOp
	Left     string
	Right    string
	Sub      *Condition
	Children []*Condition
}

// tokenType represents a lexer token.
type tokenType int

const (
	tokEOF tokenType = iota
	tokIdent
	tokString
	tokEq
	tokNeq
	tokGt
	tokLt
	tokGte
	tokLte
	tokContains
	tokMatches
	tokAnd
	tokOr
	tokNot
	tokLParen
	tokRParen
	tokHasTag
	tokNotHasTag
	tokExists
)

type token struct {
	typ tokenType
	val string
}

// conditionLexer tokenizes a condition expression.
type conditionLexer struct {
	input  string
	pos    int
	tokens []token
}

func newConditionLexer(input string) *conditionLexer {
	return &conditionLexer{input: input}
}

func (l *conditionLexer) tokenize() error {
	for l.pos < len(l.input) {
		ch := l.input[l.pos]
		switch {
		case ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r':
			l.pos++
		case ch == '(':
			l.tokens = append(l.tokens, token{tokLParen, "("})
			l.pos++
		case ch == ')':
			l.tokens = append(l.tokens, token{tokRParen, ")"})
			l.pos++
		case ch == '=' && l.peek(1) == '=':
			l.tokens = append(l.tokens, token{tokEq, "=="})
			l.pos += 2
		case ch == '!' && l.peek(1) == '=':
			l.tokens = append(l.tokens, token{tokNeq, "!="})
			l.pos += 2
		case ch == '>' && l.peek(1) == '=':
			l.tokens = append(l.tokens, token{tokGte, ">="})
			l.pos += 2
		case ch == '<' && l.peek(1) == '=':
			l.tokens = append(l.tokens, token{tokLte, "<="})
			l.pos += 2
		case ch == '>':
			l.tokens = append(l.tokens, token{tokGt, ">"})
			l.pos++
		case ch == '<':
			l.tokens = append(l.tokens, token{tokLt, "<"})
			l.pos++
		case ch == '\'' || ch == '"':
			if err := l.lexString(); err != nil {
				return err
			}
		default:
			if err := l.lexWord(); err != nil {
				return err
			}
		}
	}
	l.tokens = append(l.tokens, token{tokEOF, ""})
	return nil
}

func (l *conditionLexer) peek(offset int) byte {
	idx := l.pos + offset
	if idx < len(l.input) {
		return l.input[idx]
	}
	return 0
}

func (l *conditionLexer) lexString() error {
	quote := l.input[l.pos]
	l.pos++
	start := l.pos
	for l.pos < len(l.input) {
		if l.input[l.pos] == quote && l.input[l.pos-1] != '\\' {
			break
		}
		l.pos++
	}
	if l.pos >= len(l.input) {
		return fmt.Errorf("unterminated string literal")
	}
	val := l.input[start:l.pos]
	l.pos++
	l.tokens = append(l.tokens, token{tokString, val})
	return nil
}

func (l *conditionLexer) lexWord() error {
	start := l.pos
	for l.pos < len(l.input) {
		ch := l.input[l.pos]
		if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' ||
			ch == '(' || ch == ')' || ch == '=' || ch == '!' ||
			ch == '>' || ch == '<' || ch == '\'' || ch == '"' {
			break
		}
		l.pos++
	}
	word := l.input[start:l.pos]
	if word == "" {
		return fmt.Errorf("unexpected character at position %d", start)
	}
	switch strings.ToUpper(word) {
	case "AND":
		l.tokens = append(l.tokens, token{tokAnd, word})
	case "OR":
		l.tokens = append(l.tokens, token{tokOr, word})
	case "NOT":
		l.tokens = append(l.tokens, token{tokNot, word})
	case "CONTAINS":
		l.tokens = append(l.tokens, token{tokContains, word})
	case "MATCHES":
		l.tokens = append(l.tokens, token{tokMatches, word})
	case "HASTAG":
		l.tokens = append(l.tokens, token{tokHasTag, word})
	case "NOTHASTAG":
		l.tokens = append(l.tokens, token{tokNotHasTag, word})
	case "EXISTS":
		l.tokens = append(l.tokens, token{tokExists, word})
	default:
		l.tokens = append(l.tokens, token{tokIdent, word})
	}
	return nil
}

// conditionParser is a recursive descent parser for condition expressions.
type conditionParser struct {
	lexer *conditionLexer
	pos   int
}

func newConditionParser(lexer *conditionLexer) *conditionParser {
	return &conditionParser{lexer: lexer}
}

func (p *conditionParser) peek() token {
	if p.pos < len(p.lexer.tokens) {
		return p.lexer.tokens[p.pos]
	}
	return token{tokEOF, ""}
}

func (p *conditionParser) next() token {
	t := p.peek()
	if p.pos < len(p.lexer.tokens) {
		p.pos++
	}
	return t
}

func (p *conditionParser) expect(typ tokenType) (token, error) {
	t := p.next()
	if t.typ != typ {
		return t, fmt.Errorf("expected %v but got %q", typ, t.val)
	}
	return t, nil
}

// parseExpression parses an OR expression (lowest precedence).
func (p *conditionParser) parseExpression() (*Condition, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.peek().typ == tokOr {
		p.next()
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = &Condition{Op: OpOr, Children: []*Condition{left, right}}
	}
	return left, nil
}

// parseAnd parses an AND expression.
func (p *conditionParser) parseAnd() (*Condition, error) {
	left, err := p.parseNot()
	if err != nil {
		return nil, err
	}
	for p.peek().typ == tokAnd {
		p.next()
		right, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		left = &Condition{Op: OpAnd, Children: []*Condition{left, right}}
	}
	return left, nil
}

// parseNot parses a NOT expression.
func (p *conditionParser) parseNot() (*Condition, error) {
	if p.peek().typ == tokNot {
		p.next()
		sub, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		return &Condition{Op: OpNot, Sub: sub}, nil
	}
	return p.parsePrimary()
}

// parsePrimary parses a primary expression: parenthesized expr, hasTag/notHasTag call, or comparison.
func (p *conditionParser) parsePrimary() (*Condition, error) {
	if p.peek().typ == tokExists {
		p.next()
		if _, err := p.expect(tokLParen); err != nil {
			return nil, fmt.Errorf("expected '(' after exists")
		}
		path, err := p.expect(tokString)
		if err != nil || !conditionExistsPath.MatchString(path.val) {
			return nil, fmt.Errorf("exists requires a quoted, exact Device or InternetGatewayDevice path (no wildcards)")
		}
		if _, err := p.expect(tokRParen); err != nil {
			return nil, fmt.Errorf("missing ')' after exists path")
		}
		return &Condition{Op: OpExists, Right: strings.TrimSuffix(path.val, ".")}, nil
	}
	if p.peek().typ == tokLParen {
		p.next()
		expr, err := p.parseExpression()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokRParen); err != nil {
			return nil, fmt.Errorf("missing closing parenthesis")
		}
		return expr, nil
	}
	if p.peek().typ == tokHasTag || p.peek().typ == tokNotHasTag {
		op := p.next().typ
		if _, err := p.expect(tokLParen); err != nil {
			return nil, fmt.Errorf("expected '(' after hasTag/notHasTag")
		}
		tag, err := p.parseOperand()
		if err != nil {
			return nil, fmt.Errorf("invalid tag argument: %w", err)
		}
		if _, err := p.expect(tokRParen); err != nil {
			return nil, fmt.Errorf("missing ')' after tag argument")
		}
		condOp := OpHasTag
		if op == tokNotHasTag {
			condOp = OpNotHasTag
		}
		return &Condition{Op: condOp, Right: tag}, nil
	}
	return p.parseComparison()
}

// parseComparison parses a comparison: operand operator operand.
func (p *conditionParser) parseComparison() (*Condition, error) {
	leftTok, err := p.parseOperand()
	if err != nil {
		return nil, err
	}

	opTok := p.next()
	var cmp CompareOp
	switch opTok.typ {
	case tokEq:
		cmp = CmpEq
	case tokNeq:
		cmp = CmpNeq
	case tokGt:
		cmp = CmpGt
	case tokLt:
		cmp = CmpLt
	case tokGte:
		cmp = CmpGte
	case tokLte:
		cmp = CmpLte
	case tokContains:
		cmp = CmpContains
	case tokMatches:
		cmp = CmpMatches
	default:
		return nil, fmt.Errorf("expected comparison operator but got %q", opTok.val)
	}

	rightTok, err := p.parseOperand()
	if err != nil {
		return nil, err
	}

	return &Condition{
		Op:      OpCompare,
		Compare: cmp,
		Left:    leftTok,
		Right:   rightTok,
	}, nil
}

// parseOperand parses an operand (identifier or string literal).
func (p *conditionParser) parseOperand() (string, error) {
	t := p.next()
	switch t.typ {
	case tokIdent:
		return t.val, nil
	case tokString:
		return t.val, nil
	default:
		return "", fmt.Errorf("expected operand but got %q", t.val)
	}
}

// ParseCondition parses a condition expression string into a Condition AST.
// An empty string returns nil (meaning: always apply).
func ParseCondition(expr string) (*Condition, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil, nil
	}
	lexer := newConditionLexer(expr)
	if err := lexer.tokenize(); err != nil {
		return nil, fmt.Errorf("tokenize: %w", err)
	}
	parser := newConditionParser(lexer)
	cond, err := parser.parseExpression()
	if err != nil {
		return nil, err
	}
	if parser.peek().typ != tokEOF {
		return nil, fmt.Errorf("unexpected token %q after expression", parser.peek().val)
	}
	return cond, nil
}

// ValidateCondition checks that a condition expression is syntactically valid.
// Returns nil for empty strings (no condition = always apply).
func ValidateCondition(expr string) error {
	_, err := ParseCondition(expr)
	return err
}

// Evaluate evaluates a condition AST against a parameter map.
// Returns true if the condition is satisfied.
func Evaluate(cond *Condition, params map[string]string) (bool, error) {
	if cond == nil {
		return true, nil
	}
	switch cond.Op {
	case OpAnd:
		for _, child := range cond.Children {
			result, err := Evaluate(child, params)
			if err != nil {
				return false, err
			}
			if !result {
				return false, nil
			}
		}
		return true, nil
	case OpOr:
		for _, child := range cond.Children {
			result, err := Evaluate(child, params)
			if err != nil {
				return false, err
			}
			if result {
				return true, nil
			}
		}
		return false, nil
	case OpNot:
		result, err := Evaluate(cond.Sub, params)
		if err != nil {
			return false, err
		}
		return !result, nil
	case OpHasTag:
		return hasTag(cond.Right, params), nil
	case OpNotHasTag:
		return !hasTag(cond.Right, params), nil
	case OpExists:
		value, ok := params[conditionExistsKey(cond.Right)]
		if !ok || (value != "true" && value != "false") {
			return false, fmt.Errorf("existence could not be verified for %s", cond.Right)
		}
		return value == "true", nil
	case OpCompare:
		return evaluateCompare(cond, params)
	default:
		return false, fmt.Errorf("unknown condition op %d", cond.Op)
	}
}

func evaluateCompare(cond *Condition, params map[string]string) (bool, error) {
	leftVal, leftIsParam := params[cond.Left]
	rightVal, rightIsParam := params[cond.Right]

	if rightIsParam {
		// Both sides are parameter values
	} else {
		rightVal = cond.Right
	}
	if !leftIsParam {
		leftVal = cond.Left
	}

	switch cond.Compare {
	case CmpEq:
		return leftVal == rightVal, nil
	case CmpNeq:
		return leftVal != rightVal, nil
	case CmpGt:
		return compareNumeric(leftVal, rightVal) > 0, nil
	case CmpLt:
		return compareNumeric(leftVal, rightVal) < 0, nil
	case CmpGte:
		return compareNumeric(leftVal, rightVal) >= 0, nil
	case CmpLte:
		return compareNumeric(leftVal, rightVal) <= 0, nil
	case CmpContains:
		return strings.Contains(leftVal, rightVal), nil
	case CmpMatches:
		matched, err := regexp.MatchString(rightVal, leftVal)
		if err != nil {
			return false, fmt.Errorf("invalid regex %q: %w", rightVal, err)
		}
		return matched, nil
	default:
		return false, fmt.Errorf("unknown compare op %d", cond.Compare)
	}
}

// hasTag checks whether the device (identified by the "device.tags" key in
// params, a comma-separated list) carries the given tag.
func hasTag(tag string, params map[string]string) bool {
	tagsStr, ok := params["device.tags"]
	if !ok || tagsStr == "" {
		return false
	}
	for _, t := range strings.Split(tagsStr, ",") {
		if strings.TrimSpace(t) == tag {
			return true
		}
	}
	return false
}

func compareNumeric(a, b string) int {
	ai, aerr := parseNumber(a)
	bi, berr := parseNumber(b)
	if aerr == nil && berr == nil {
		switch {
		case ai < bi:
			return -1
		case ai > bi:
			return 1
		default:
			return 0
		}
	}
	return strings.Compare(a, b)
}

func parseNumber(s string) (float64, error) {
	var f float64
	_, err := fmt.Sscanf(s, "%g", &f)
	return f, err
}

// ExtractParamNames extracts all CWMP parameter paths referenced in a condition.
// These are the parameters that need to be fetched via GPV before evaluation.
func ExtractParamNames(cond *Condition) []string {
	if cond == nil {
		return nil
	}
	seen := make(map[string]bool)
	var result []string
	collectParams(cond, seen, &result)
	return result
}

func collectParams(cond *Condition, seen map[string]bool, result *[]string) {
	switch cond.Op {
	case OpCompare:
		if isParamPath(cond.Left) {
			if !seen[cond.Left] {
				seen[cond.Left] = true
				*result = append(*result, cond.Left)
			}
		}
		if isParamPath(cond.Right) {
			if !seen[cond.Right] {
				seen[cond.Right] = true
				*result = append(*result, cond.Right)
			}
		}
	case OpAnd, OpOr:
		for _, child := range cond.Children {
			collectParams(child, seen, result)
		}
	case OpNot:
		collectParams(cond.Sub, seen, result)
	case OpHasTag, OpNotHasTag:
		// Device-attr functions: no CWMP params needed.
	}
}

// isParamPath heuristically checks if a string looks like a CWMP parameter path.
func isParamPath(s string) bool {
	if !strings.Contains(s, ".") {
		return false
	}
	if len(s) == 0 {
		return false
	}
	return s[0] >= 'A' && s[0] <= 'Z'
}

var conditionExistsPath = regexp.MustCompile(`^(Device|InternetGatewayDevice)(\.[A-Za-z0-9_-]+)*\.?$`)

// Keep probe results separate from CPE-supplied values and device attributes.
func conditionExistsKey(path string) string {
	return "\x00exists:" + strings.TrimSuffix(path, ".")
}

func extractExistsPaths(cond *Condition, seen map[string]bool, paths *[]string) {
	if cond == nil {
		return
	}
	if cond.Op == OpExists && !seen[cond.Right] {
		seen[cond.Right] = true
		*paths = append(*paths, cond.Right)
	}
	extractExistsPaths(cond.Sub, seen, paths)
	for _, child := range cond.Children {
		extractExistsPaths(child, seen, paths)
	}
}
