import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createThinkingReporter,
	resolveThinkingPartConstructor,
	type ThinkingPartLike,
} from '../thinkingParts';

function recordingReporter(api: unknown) {
	const parts: ThinkingPartLike[] = [];
	const texts: string[] = [];
	const unavailable: string[] = [];
	const report = createThinkingReporter({
		api,
		report: (part) => parts.push(part),
		fallback: (text) => texts.push(text),
		onUnavailable: (reason) => unavailable.push(reason),
	});
	return { report, parts, texts, unavailable };
}

test('resolveThinkingPartConstructor ignores non-constructors and unreadable properties', () => {
	assert.equal(resolveThinkingPartConstructor(undefined), undefined);
	assert.equal(resolveThinkingPartConstructor({}), undefined);
	assert.equal(resolveThinkingPartConstructor({ LanguageModelThinkingPart: 'nope' }), undefined);

	const guarded = {
		get LanguageModelThinkingPart(): unknown {
			throw new Error('Extension cannot use API proposal: languageModelThinkingPart');
		},
	};
	assert.equal(resolveThinkingPartConstructor(guarded), undefined);
});

test('createThinkingReporter emits native parts when the proposed class exists', () => {
	class FakeThinkingPart implements ThinkingPartLike {
		constructor(readonly value: string) {}
	}
	const { report, parts, texts, unavailable } = recordingReporter({
		LanguageModelThinkingPart: FakeThinkingPart,
	});

	report('step one');
	report('step two');

	assert.deepEqual(
		parts.map((part) => part.value),
		['step one', 'step two']
	);
	assert.deepEqual(texts, []);
	assert.deepEqual(unavailable, []);
});

test('createThinkingReporter falls back to text and notifies once without the proposal', () => {
	const { report, parts, texts, unavailable } = recordingReporter({});

	report('step one');
	report('step two');

	assert.deepEqual(parts, []);
	assert.deepEqual(texts, ['step one', 'step two']);
	assert.equal(unavailable.length, 1);
	assert.match(unavailable[0], /languageModelThinkingPart/);
});

test('createThinkingReporter falls back for the same delta when the constructor throws', () => {
	let constructed = 0;
	class ExplodingThinkingPart {
		constructor() {
			constructed += 1;
			throw new Error('thinking parts are not supported here');
		}
	}
	const { report, parts, texts, unavailable } = recordingReporter({
		LanguageModelThinkingPart: ExplodingThinkingPart,
	});

	report('step one');
	report('step two');

	assert.equal(constructed, 1, 'the unusable constructor is not retried');
	assert.deepEqual(parts, []);
	assert.deepEqual(texts, ['step one', 'step two']);
	assert.deepEqual(unavailable, ['thinking parts are not supported here']);
});

test('createThinkingReporter falls back when reporting a part throws', () => {
	const texts: string[] = [];
	const report = createThinkingReporter({
		api: { LanguageModelThinkingPart: class { constructor(readonly value: string) {} } },
		report: () => {
			throw new Error('progress stream closed');
		},
		fallback: (text) => texts.push(text),
	});

	report('step one');
	report('step two');

	assert.deepEqual(texts, ['step one', 'step two']);
});
