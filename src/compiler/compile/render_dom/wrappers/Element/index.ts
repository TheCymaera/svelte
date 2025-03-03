import Renderer from '../../Renderer';
import Element from '../../../nodes/Element';
import Wrapper from '../shared/Wrapper';
import Block from '../../Block';
import { is_void } from '../../../../../shared/utils/names';
import FragmentWrapper from '../Fragment';
import { escape_html, string_literal } from '../../../utils/stringify';
import TextWrapper from '../Text';
import fix_attribute_casing from './fix_attribute_casing';
import { b, x, p } from 'code-red';
import { namespaces } from '../../../../utils/namespaces';
import AttributeWrapper from './Attribute';
import StyleAttributeWrapper from './StyleAttribute';
import SpreadAttributeWrapper from './SpreadAttribute';
import { regex_dimensions, regex_starts_with_newline, regex_backslashes, regex_border_box_size, regex_content_box_size, regex_device_pixel_content_box_size, regex_content_rect } from '../../../../utils/patterns';
import Binding from './Binding';
import add_to_set from '../../../utils/add_to_set';
import { add_event_handler } from '../shared/add_event_handlers';
import { add_action } from '../shared/add_actions';
import bind_this from '../shared/bind_this';
import { is_head } from '../shared/is_head';
import { Identifier, ExpressionStatement, CallExpression, Node } from 'estree';
import EventHandler from './EventHandler';
import { extract_names } from 'periscopic';
import Action from '../../../nodes/Action';
import MustacheTagWrapper from '../MustacheTag';
import RawMustacheTagWrapper from '../RawMustacheTag';
import is_dynamic from '../shared/is_dynamic';
import { is_name_contenteditable, has_contenteditable_attr } from '../../../utils/contenteditable';
import create_debugging_comment from '../shared/create_debugging_comment';
import { push_array } from '../../../../utils/push_array';

interface BindingGroup {
	events: string[];
	bindings: Binding[];
}

const regex_contains_radio_or_checkbox_or_file = /radio|checkbox|file/;
const regex_contains_radio_or_checkbox_or_range_or_file = /radio|checkbox|range|file/;

const events = [
	{
		event_names: ['input'],
		filter: (node: Element, _name: string) =>
			node.name === 'textarea' ||
			node.name === 'input' &&
			!regex_contains_radio_or_checkbox_or_range_or_file.test(node.get_static_attribute_value('type') as string)
	},
	{
		event_names: ['input'],
		filter: (node: Element, name: string) =>
			is_name_contenteditable(name) &&
			has_contenteditable_attr(node)
	},
	{
		event_names: ['change'],
		filter: (node: Element, _name: string) =>
			node.name === 'select' ||
			node.name === 'input' &&
			regex_contains_radio_or_checkbox_or_file.test(node.get_static_attribute_value('type') as string)
	},
	{
		event_names: ['change', 'input'],
		filter: (node: Element, _name: string) =>
			node.name === 'input' && node.get_static_attribute_value('type') === 'range'
	},
	// resize events
	{
		event_names: ['elementresize'],
		filter: (_node: Element, name: string) =>
			regex_dimensions.test(name)
	},
	{
		event_names: ['elementresizecontentbox'],
		filter: (_node: Element, name: string) =>
			regex_content_rect.test(name) ?? regex_content_box_size.test(name)
	},

	{
		event_names: ['elementresizeborderbox'],
		filter: (_node: Element, name: string) => 
			regex_border_box_size.test(name)
	},

	{
		event_names: ['elementresizedevicepixelcontentbox'],
		filter: (_node: Element, name: string) =>
			regex_device_pixel_content_box_size.test(name)
	},
	// media events
	{
		event_names: ['timeupdate'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			(name === 'currentTime' || name === 'played' || name === 'ended')
	},
	{
		event_names: ['durationchange'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			name === 'duration'
	},
	{
		event_names: ['play', 'pause'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			name === 'paused'
	},
	{
		event_names: ['progress'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			name === 'buffered'
	},
	{
		event_names: ['loadedmetadata'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			(name === 'buffered' || name === 'seekable')
	},
	{
		event_names: ['volumechange'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			(name === 'volume' || name === 'muted')
	},
	{
		event_names: ['ratechange'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			name === 'playbackRate'
	},
	{
		event_names: ['seeking', 'seeked'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			(name === 'seeking')
	},
	{
		event_names: ['ended'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			name === 'ended'
	},
	{
		event_names: ['resize'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			(name === 'videoHeight' || name === 'videoWidth')
	},
	{
		// from https://html.spec.whatwg.org/multipage/media.html#ready-states
		// and https://html.spec.whatwg.org/multipage/media.html#loading-the-media-resource
		event_names: ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'waiting', 'emptied'],
		filter: (node: Element, name: string) =>
			node.is_media_node() &&
			name === 'readyState'
	},
	// details event
	{
		event_names: ['toggle'],
		filter: (node: Element, _name: string) =>
			node.name === 'details'
	},
	{
		event_names: ['load'],
		filter: (_: Element, name: string) => name === 'naturalHeight' || name === 'naturalWidth'
	}
];

const CHILD_DYNAMIC_ELEMENT_BLOCK = 'child_dynamic_element';
const regex_invalid_variable_identifier_characters = /[^a-zA-Z0-9_$]/g;
const regex_minus_signs = /-/g;

export default class ElementWrapper extends Wrapper {
	node: Element;
	fragment: FragmentWrapper;
	attributes: Array<AttributeWrapper | StyleAttributeWrapper | SpreadAttributeWrapper>;
	bindings: Binding[];
	event_handlers: EventHandler[];
	class_dependencies: string[];
	dynamic_style_dependencies: Set<string>;
	has_dynamic_attribute: boolean;

	select_binding_dependencies?: Set<string>;
	has_dynamic_value: boolean;
	dynamic_value_condition: any;

	var: any;
	void: boolean;

	child_dynamic_element_block?: Block = null;
	child_dynamic_element?: ElementWrapper = null;

	element_data_name = null;

	constructor(
		renderer: Renderer,
		block: Block,
		parent: Wrapper,
		node: Element,
		strip_whitespace: boolean,
		next_sibling: Wrapper
	) {
		super(renderer, block, parent, node);

		this.var = {
			type: 'Identifier',
			name: node.name.replace(regex_invalid_variable_identifier_characters, '_')
		};

		this.void = is_void(node.name);

		this.class_dependencies = [];

		if (node.is_dynamic_element && block.type !== CHILD_DYNAMIC_ELEMENT_BLOCK) {
			this.child_dynamic_element_block = block.child({
				comment: create_debugging_comment(node, renderer.component),
				name: renderer.component.get_unique_name('create_dynamic_element'),
				type: CHILD_DYNAMIC_ELEMENT_BLOCK
			});
			renderer.blocks.push(this.child_dynamic_element_block);
			this.child_dynamic_element = new ElementWrapper(
				renderer,
				this.child_dynamic_element_block,
				parent,
				node,
				strip_whitespace,
				next_sibling
			);

			// the original svelte:element is never used for rendering, because
			// it gets assigned a child_dynamic_element which is used in all rendering logic.
			// so doing all of this on the original svelte:element will just cause double
			// code, because it will be done again on the child_dynamic_element.
			return;
		}

		this.dynamic_style_dependencies = new Set();

		if (this.node.children.length) {
			this.node.lets.forEach(l => {
				extract_names(l.value || l.name).forEach(name => {
					renderer.add_to_context(name, true);
				});
			});
		}

		this.attributes = this.node.attributes.map(attribute => {
			if (attribute.name === 'style') {
				return new StyleAttributeWrapper(this, block, attribute);
			}
			if (attribute.type === 'Spread') {
				return new SpreadAttributeWrapper(this, block, attribute);
			}
			return new AttributeWrapper(this, block, attribute);
		});
		this.has_dynamic_attribute = !!this.attributes.find(attr => attr.node.get_dependencies().length > 0);

		// ordinarily, there'll only be one... but we need to handle
		// the rare case where an element can have multiple bindings,
		// e.g. <audio bind:paused bind:currentTime>
		this.bindings = this.node.bindings.map(binding => new Binding(block, binding, this));

		this.event_handlers = this.node.handlers.map(event_handler => new EventHandler(event_handler, this));

		if (node.intro || node.outro) {
			if (node.intro) block.add_intro(node.intro.is_local);
			if (node.outro) block.add_outro(node.outro.is_local);
		}

		if (node.animation) {
			block.add_animation();
		}

		block.add_dependencies(node.tag_expr.dependencies);

		// add directive and handler dependencies
		[node.animation, node.outro, ...node.actions, ...node.classes, ...node.styles].forEach(directive => {
			if (directive && directive.expression) {
				block.add_dependencies(directive.expression.dependencies);
			}
		});

		node.handlers.forEach(handler => {
			if (handler.expression) {
				block.add_dependencies(handler.expression.dependencies);
			}
		});

		if (this.parent) {
			if (node.actions.length > 0 ||
				node.animation ||
				node.bindings.length > 0 ||
				node.classes.length > 0 ||
				node.intro || node.outro ||
				node.handlers.length > 0 ||
				node.styles.length > 0 ||
				this.node.name === 'option' ||
				node.tag_expr.dynamic_dependencies().length ||
				node.is_dynamic_element ||
				renderer.options.dev
			) {
				this.parent.cannot_use_innerhtml(); // need to use add_location
				this.parent.not_static_content();
			}
		}

		this.fragment = new FragmentWrapper(renderer, block, node.children, this, strip_whitespace, next_sibling);

		this.element_data_name = block.get_unique_name(`${this.var.name}_data`);
	}

	render(block: Block, parent_node: Identifier, parent_nodes: Identifier) {
		if (this.child_dynamic_element) {
			this.render_dynamic_element(block, parent_node, parent_nodes);
		} else {
			this.render_element(block, parent_node, parent_nodes);
		}
	}

	render_dynamic_element(block: Block, parent_node: Identifier, parent_nodes: Identifier) {
		this.child_dynamic_element.render(
			this.child_dynamic_element_block,
			null,
			(x`#nodes` as unknown) as Identifier
		);

		const is_tag_dynamic = this.node.tag_expr.dynamic_dependencies().length > 0;
		const tag = this.node.tag_expr.manipulate(block);

		block.chunks.init.push(b`
			${this.renderer.options.dev && b`@validate_dynamic_element(${tag});`}
			${this.renderer.options.dev && this.node.children.length > 0 && b`@validate_void_dynamic_element(${tag});`}
			let ${this.var} = ${tag} && ${this.child_dynamic_element_block.name}(#ctx);
		`);

		block.chunks.create.push(b`
			if (${this.var}) ${this.var}.c();
		`);

		if (this.renderer.options.hydratable) {
			block.chunks.claim.push(b`
				if (${this.var}) ${this.var}.l(${parent_nodes});
			`);
		}

		block.chunks.mount.push(b`
			if (${this.var}) ${this.var}.m(${parent_node || '#target'}, ${parent_node ? 'null' : '#anchor'});
		`);

		if (is_tag_dynamic) {
			const previous_tag = block.get_unique_name('previous_tag');
			block.add_variable(previous_tag, tag);
			const anchor = this.get_or_create_anchor(block, parent_node, parent_nodes);
			const has_transitions = !!(this.node.intro || this.node.outro);
			const not_equal = this.renderer.component.component_options.immutable ? x`@not_equal` : x`@safe_not_equal`;

			const tag_will_be_removed = block.get_unique_name('tag_will_be_removed');
			if (has_transitions) {
				block.add_variable(tag_will_be_removed, x`false`);
			}

			block.chunks.update.push(b`
				if (${tag}) {
					if (!${previous_tag}) {
						${this.var} = ${this.child_dynamic_element_block.name}(#ctx);
						${previous_tag} = ${tag};
						${this.var}.c();
						${has_transitions && b`@transition_in(${this.var})`}
						${this.var}.m(${this.get_update_mount_node(anchor)}, ${anchor});
					} else if (${not_equal}(${previous_tag}, ${tag})) {
						${this.var}.d(1);
						${this.renderer.options.dev && b`@validate_dynamic_element(${tag});`}
						${this.renderer.options.dev && this.node.children.length > 0 && b`@validate_void_dynamic_element(${tag});`}
						${this.var} = ${this.child_dynamic_element_block.name}(#ctx);
						${previous_tag} = ${tag};
						${this.var}.c();
						${has_transitions && b`if (${tag_will_be_removed}) {
							${tag_will_be_removed} = false;
							@transition_in(${this.var})
						}`}
						${this.var}.m(${this.get_update_mount_node(anchor)}, ${anchor});
					} else {
						${has_transitions && b`if (${tag_will_be_removed}) {
							${tag_will_be_removed} = false;
							@transition_in(${this.var})
						}`}
						${this.var}.p(#ctx, #dirty);
					}
				} else if (${previous_tag}) {
					${has_transitions
					? b`
								${tag_will_be_removed} = true;
								@group_outros();
								@transition_out(${this.var}, 1, 1, () => {
									${this.var} = null;
									${previous_tag} = ${tag};
									${tag_will_be_removed} = false;
								});
								@check_outros();
							`
					: b`
								${this.var}.d(1);
								${this.var} = null;
								${previous_tag} = ${tag};
							`
				}
				}
			`);
		} else {
			block.chunks.update.push(b`
				if (${tag}) {
					${this.var}.p(#ctx, #dirty);
				}
			`);
		}

		if (this.child_dynamic_element_block.has_intros) {
			block.chunks.intro.push(b`@transition_in(${this.var});`);
		}

		if (this.child_dynamic_element_block.has_outros) {
			block.chunks.outro.push(b`@transition_out(${this.var});`);
		}

		block.chunks.destroy.push(b`if (${this.var}) ${this.var}.d(detaching)`);

		if (this.node.animation) {
			const measurements = block.get_unique_name('measurements');
			block.add_variable(measurements);
			block.chunks.measure.push(b`${measurements} = ${this.var}.r()`);
			block.chunks.fix.push(b`${this.var}.f();`);
			block.chunks.animate.push(b`
				${this.var}.s(${measurements});
				${this.var}.a()
			`);
		}
	}

	is_dom_node() {
		return super.is_dom_node() && !this.child_dynamic_element;
	}

	render_element(block: Block, parent_node: Identifier, parent_nodes: Identifier) {

		const { renderer } = this;

		if (this.node.name === 'noscript') return;

		const node = this.var;
		const nodes = parent_nodes && block.get_unique_name(`${this.var.name}_nodes`); // if we're in unclaimable territory, i.e. <head>, parent_nodes is null
		const children = x`@children(${this.node.name === 'template' ? x`${node}.content` : node})`;

		block.add_variable(node);
		const render_statement = this.get_render_statement(block);
		block.chunks.create.push(
			b`${node} = ${render_statement};`
		);

		if (renderer.options.hydratable) {
			if (parent_nodes) {
				block.chunks.claim.push(b`
					${node} = ${this.get_claim_statement(block, parent_nodes)};
				`);

				if (!this.void && this.node.children.length > 0) {
					block.chunks.claim.push(b`
						var ${nodes} = ${children};
					`);
				}
			} else {
				block.chunks.claim.push(
					b`${node} = ${render_statement};`
				);
			}
		}

		if (parent_node) {
			const append = b`@append(${parent_node}, ${node});`;
			((append[0] as ExpressionStatement).expression as CallExpression).callee.loc = {
				start: this.renderer.locate(this.node.start),
				end: this.renderer.locate(this.node.end)
			};
			block.chunks.mount.push(append);

			if (is_head(parent_node)) {
				block.chunks.destroy.push(b`@detach(${node});`);
			}
		} else {
			const insert = b`@insert(#target, ${node}, #anchor);`;
			((insert[0] as ExpressionStatement).expression as CallExpression).callee.loc = {
				start: this.renderer.locate(this.node.start),
				end: this.renderer.locate(this.node.end)
			};
			block.chunks.mount.push(insert);

			// TODO we eventually need to consider what happens to elements
			// that belong to the same outgroup as an outroing element...
			block.chunks.destroy.push(b`if (detaching) @detach(${node});`);
		}

		// insert static children with textContent or innerHTML
		// skip textcontent for <template>.  append nodes to TemplateElement.content instead
		const can_use_textcontent = this.can_use_textcontent();
		const is_template = this.node.name === 'template';
		const is_template_with_text_content = is_template && can_use_textcontent;

		if (!is_template_with_text_content && !this.node.namespace && (this.can_use_innerhtml || can_use_textcontent) && this.fragment.nodes.length > 0) {
			if (this.fragment.nodes.length === 1 && this.fragment.nodes[0].node.type === 'Text') {
				block.chunks.create.push(
					b`${node}.textContent = ${string_literal((this.fragment.nodes[0] as TextWrapper).data)};`
				);
			} else {
				const state = {
					quasi: {
						type: 'TemplateElement',
						value: { raw: '' }
					}
				};

				const literal = {
					type: 'TemplateLiteral',
					expressions: [],
					quasis: []
				};

				const can_use_raw_text = !this.can_use_innerhtml && can_use_textcontent;
				to_html((this.fragment.nodes as unknown as Array<ElementWrapper | TextWrapper>), block, literal, state, can_use_raw_text);
				literal.quasis.push(state.quasi);

				block.chunks.create.push(
					b`${node}.${this.can_use_innerhtml ? 'innerHTML' : 'textContent'} = ${literal};`
				);
			}
		} else {
			this.fragment.nodes.forEach((child: Wrapper) => {
				child.render(
					block,
					is_template ? x`${node}.content` : node,
					nodes,
					{ element_data_name: this.element_data_name }
				);
			});
		}

		const event_handler_or_binding_uses_context = (
			this.bindings.some(binding => binding.handler.uses_context) ||
			this.node.handlers.some(handler => handler.uses_context) ||
			this.node.actions.some(action => action.uses_context)
		);

		if (event_handler_or_binding_uses_context) {
			block.maintain_context = true;
		}

		if (this.node.is_dynamic_element) {
			this.add_dynamic_element_attributes(block);
		} else {
			this.add_attributes(block);
		}
		this.add_directives_in_order(block);
		this.add_transitions(block);
		this.add_animation(block);
		this.add_classes(block);
		this.add_styles(block);
		this.add_manual_style_scoping(block);

		if (nodes && this.renderer.options.hydratable && !this.void) {
			block.chunks.claim.push(
				b`${this.node.children.length > 0 ? nodes : children}.forEach(@detach);`
			);
		}

		if (renderer.options.dev) {
			const loc = renderer.locate(this.node.start);
			block.chunks.hydrate.push(
				b`@add_location(${this.var}, ${renderer.file_var}, ${loc.line - 1}, ${loc.column}, ${this.node.start});`
			);
		}

		block.renderer.dirty(this.node.tag_expr.dynamic_dependencies());
	}

	can_use_textcontent() {
		return this.is_static_content && this.fragment.nodes.every(node => node.node.type === 'Text' || node.node.type === 'MustacheTag');
	}

	get_render_statement(block: Block) {
		const { name, namespace, tag_expr } = this.node;
		const reference = tag_expr.manipulate(block);

		if (namespace === namespaces.svg) {
			return x`@svg_element(${reference})`;
		}

		if (namespace) {
			return x`@_document.createElementNS("${namespace}", "${name}")`;
		}

		const is: AttributeWrapper = this.attributes.find(attr => attr.node.name === 'is') as any;
		if (is) {
			return x`@element_is("${name}", ${is.render_chunks(block).reduce((lhs, rhs) => x`${lhs} + ${rhs}`)})`;
		}

		return x`@element(${reference})`;
	}

	get_claim_statement(block: Block, nodes: Identifier) {
		const attributes = this.attributes
			.filter((attr) => !(attr instanceof SpreadAttributeWrapper) && !attr.property_name)
			.map((attr) => p`${(attr as StyleAttributeWrapper | AttributeWrapper).name}: true`);

		let reference: string | ReturnType<typeof x>;
		if (this.node.tag_expr.node.type === 'Literal') {
			if (this.node.namespace) {
				reference = `"${this.node.tag_expr.node.value}"`;
			} else {
				reference = `"${(this.node.tag_expr.node.value as String || '').toUpperCase()}"`;
			}
		} else if (this.node.namespace) {
			reference = x`${this.node.tag_expr.manipulate(block)}`;
		} else {
			reference = x`(${this.node.tag_expr.manipulate(block)} || 'null').toUpperCase()`;
		}

		if (this.node.namespace === namespaces.svg) {
			return x`@claim_svg_element(${nodes}, ${reference}, { ${attributes} })`;
		} else {
			return x`@claim_element(${nodes}, ${reference}, { ${attributes} })`;
		}
	}

	add_directives_in_order(block: Block) {
		type OrderedAttribute = EventHandler | BindingGroup | Binding | Action;

		const binding_groups = events
			.map(event => ({
				events: event.event_names,
				bindings: this.bindings
					.filter(binding => binding.node.name !== 'this')
					.filter(binding => event.filter(this.node, binding.node.name))
			}))
			.filter(group => group.bindings.length);

		const this_binding = this.bindings.find(b => b.node.name === 'this');

		function getOrder(item: OrderedAttribute) {
			if (item instanceof EventHandler) {
				return item.node.start;
			} else if (item instanceof Binding) {
				return item.node.start;
			} else if (item instanceof Action) {
				return item.start;
			} else {
				return item.bindings[0].node.start;
			}
		}

		([
			...binding_groups,
			...this.event_handlers,
			this_binding,
			...this.node.actions
		] as OrderedAttribute[])
			.filter(Boolean)
			.sort((a, b) => getOrder(a) - getOrder(b))
			.forEach(item => {
				if (item instanceof EventHandler) {
					add_event_handler(block, this.var, item);
				} else if (item instanceof Binding) {
					this.add_this_binding(block, item);
				} else if (item instanceof Action) {
					add_action(block, this.var, item);
				} else {
					this.add_bindings(block, item);
				}
			});
	}

	add_bindings(block: Block, binding_group: BindingGroup) {
		const { renderer } = this;

		if (binding_group.bindings.length === 0) return;

		renderer.component.has_reactive_assignments = true;

		const lock = binding_group.bindings.some(binding => binding.needs_lock) ?
			block.get_unique_name(`${this.var.name}_updating`) :
			null;

		if (lock) block.add_variable(lock, x`false`);

		const handler = renderer.component.get_unique_name(`${this.var.name}_${binding_group.events.join('_')}_handler`);
		renderer.add_to_context(handler.name);

		// TODO figure out how to handle locks
		const needs_lock = binding_group.bindings.some(binding => binding.needs_lock);

		const dependencies: Set<string> = new Set();
		const contextual_dependencies: Set<string> = new Set();

		binding_group.bindings.forEach(binding => {
			// TODO this is a mess
			add_to_set(dependencies, binding.get_update_dependencies());
			add_to_set(contextual_dependencies, binding.handler.contextual_dependencies);

			binding.render(block, lock);
		});

		// media bindings — awkward special case. The native timeupdate events
		// fire too infrequently, so we need to take matters into our
		// own hands
		let animation_frame: Identifier | undefined;
		if (binding_group.events[0] === 'timeupdate') {
			animation_frame = block.get_unique_name(`${this.var.name}_animationframe`);
			block.add_variable(animation_frame);
		}

		const has_local_function = contextual_dependencies.size > 0 || needs_lock || animation_frame;

		let callee = renderer.reference(handler);

		// TODO dry this out — similar code for event handlers and component bindings
		if (has_local_function) {
			const args = Array.from(contextual_dependencies).map(name => renderer.reference(name));

			// need to create a block-local function that calls an instance-level function
			if (animation_frame) {
				block.chunks.init.push(b`
					function ${handler}() {
						@_cancelAnimationFrame(${animation_frame});
						if (!${this.var}.paused) {
							${animation_frame} = @raf(${handler});
							${needs_lock && b`${lock} = true;`}
						}
						${callee}.call(${this.var}, ${args});
					}
				`);
			} else {
				block.chunks.init.push(b`
					function ${handler}() {
						${needs_lock && b`${lock} = true;`}
						${callee}.call(${this.var}, ${args});
					}
				`);
			}

			callee = handler;
		}

		const params = Array.from(contextual_dependencies).map(name => ({
			type: 'Identifier',
			name
		}));

		this.renderer.component.partly_hoisted.push(b`
			function ${handler}(${params}) {
				${binding_group.bindings.map(b => b.handler.mutation)}
				${Array.from(dependencies)
				.filter(dep => dep[0] !== '$')
				.filter(dep => !contextual_dependencies.has(dep))
				.map(dep => b`${this.renderer.invalidate(dep)};`)}
			}
		`);

		binding_group.events.forEach(name => {
			const resizeListenerFunctions = {
				elementresize: 'add_iframe_resize_listener',
				elementresizecontentbox: 'resize_observer_content_box.observe',
				elementresizeborderbox: 'resize_observer_border_box.observe',
				elementresizedevicepixelcontentbox: 'resize_observer_device_pixel_content_box.observe'
			};

			if (name in resizeListenerFunctions) {
				const resize_listener = block.get_unique_name(`${this.var.name}_resize_listener`);
				block.add_variable(resize_listener);

				block.chunks.mount.push(
					b`${resize_listener} = @${resizeListenerFunctions[name]}(${this.var}, ${callee}.bind(${this.var}));`
				);

				block.chunks.destroy.push(
					b`${resize_listener}();`
				);
			} else {
				block.event_listeners.push(
					x`@listen(${this.var}, "${name}", ${callee})`
				);
			}
		});

		const some_initial_state_is_undefined = binding_group.bindings
			.map(binding => x`${binding.snippet} === void 0`)
			.reduce((lhs, rhs) => x`${lhs} || ${rhs}`);

		const should_initialise = (
			this.node.name === 'select' ||
			binding_group.bindings.find(binding => (
				binding.node.name === 'indeterminate' ||
				is_name_contenteditable(binding.node.name) ||
				binding.is_readonly_media_attribute()
			))
		);

		if (should_initialise) {
			const callback = has_local_function ? handler : x`() => ${callee}.call(${this.var})`;
			block.chunks.hydrate.push(
				b`if (${some_initial_state_is_undefined}) @add_render_callback(${callback});`
			);
		}

		if (binding_group.events[0] === 'elementresize') {
			block.chunks.hydrate.push(
				b`@add_render_callback(() => ${callee}.call(${this.var}));`
			);
		}

		if (lock) {
			block.chunks.update.push(b`${lock} = false;`);
		}
	}

	add_this_binding(block: Block, this_binding: Binding) {
		const { renderer } = this;

		renderer.component.has_reactive_assignments = true;

		const binding_callback = bind_this(renderer.component, block, this_binding, this.var);
		block.chunks.mount.push(binding_callback);
	}

	add_attributes(block: Block) {
		// Get all the class and style dependencies first
		this.attributes.forEach((attribute) => {
			if (attribute.node.name === 'class') {
				const dependencies = attribute.node.get_dependencies();
				push_array(this.class_dependencies, dependencies);
			} else if (attribute.node.name === 'style') {
				add_to_set(this.dynamic_style_dependencies, attribute.node.get_dependencies());
			}
		});

		if (this.node.attributes.some(attr => attr.is_spread)) {
			this.add_spread_attributes(block);
			return;
		}

		this.attributes.forEach((attribute) => {
			attribute.render(block);
		});
	}

	add_spread_attributes(block: Block) {
		const levels = block.get_unique_name(`${this.var.name}_levels`);

		const initial_props = [];
		const updates = [];

		this.attributes
			.forEach(attr => {
				const dependencies = attr.node.get_dependencies();

				const condition = dependencies.length > 0
					? block.renderer.dirty(dependencies)
					: null;

				if (attr instanceof SpreadAttributeWrapper) {
					const snippet = attr.node.expression.manipulate(block);

					initial_props.push(snippet);

					updates.push(condition ? x`${condition} && ${snippet}` : snippet);
				} else {
					const name = attr.property_name || attr.name;
					initial_props.push(x`{ ${name}: ${attr.get_init(block, attr.get_value(block))} }`);
					const snippet = x`{ ${name}: ${attr.should_cache ? attr.last : attr.get_value(block)} }`;

					updates.push(condition ? x`${attr.get_dom_update_conditions(block, condition)} && ${snippet}` : snippet);
				}
			});

		block.chunks.init.push(b`
			let ${levels} = [${initial_props}];

			let ${this.element_data_name} = {};
			for (let #i = 0; #i < ${levels}.length; #i += 1) {
				${this.element_data_name} = @assign(${this.element_data_name}, ${levels}[#i]);
			}
		`);

		const fn =
			this.node.namespace === namespaces.svg
				? x`@set_svg_attributes`
				: this.node.is_dynamic_element
					? x`@set_dynamic_element_data(${this.node.tag_expr.manipulate(block)})`
					: x`@set_attributes`;

		block.chunks.hydrate.push(
			b`${fn}(${this.var}, ${this.element_data_name});`
		);

		if (this.has_dynamic_attribute) {
			block.chunks.update.push(b`
				${fn}(${this.var}, ${this.element_data_name} = @get_spread_update(${levels}, [
					${updates}
				]));
			`);
		}

		// handle edge cases for elements
		if (this.node.name === 'select') {
			const dependencies = new Set<string>();
			for (const attr of this.attributes) {
				for (const dep of attr.node.dependencies) {
					dependencies.add(dep);
				}
			}

			block.chunks.mount.push(b`
				'value' in ${this.element_data_name} && (${this.element_data_name}.multiple ? @select_options : @select_option)(${this.var}, ${this.element_data_name}.value);
			`);

			block.chunks.update.push(b`
				if (${block.renderer.dirty(Array.from(dependencies))} && 'value' in ${this.element_data_name}) (${this.element_data_name}.multiple ? @select_options : @select_option)(${this.var}, ${this.element_data_name}.value);
			`);
		} else if (this.node.name === 'input' && this.attributes.find(attr => attr.node.name === 'value')) {
			const type = this.node.get_static_attribute_value('type');
			if (type === null || type === '' || type === 'text' || type === 'email' || type === 'password') {
				block.chunks.mount.push(b`
					if ('value' in ${this.element_data_name}) {
						${this.var}.value = ${this.element_data_name}.value;
					}
				`);
				block.chunks.update.push(b`
					if ('value' in ${this.element_data_name}) {
						${this.var}.value = ${this.element_data_name}.value;
					}
				`);
			}
		}

		if (['button', 'input', 'keygen', 'select', 'textarea'].includes(this.node.name)) {
			block.chunks.mount.push(b`
				if (${this.var}.autofocus) ${this.var}.focus();
			`);
		}
	}

	add_dynamic_element_attributes(block: Block) {
		if (this.attributes.length === 0) return;

		if (this.has_dynamic_attribute) {
			this.add_spread_attributes(block);
			return;
		}

		const static_attributes = [];
		this.attributes.forEach((attr) => {
			if (attr instanceof SpreadAttributeWrapper) {
				static_attributes.push({ type: 'SpreadElement', argument: attr.node.expression.node });
			} else {
				const name = attr.property_name || attr.name;
				static_attributes.push(p`${name}: ${attr.get_value(block)}`);
			}
		});
		const fn =
			this.node.namespace === namespaces.svg
				? x`@set_svg_attributes`
				: this.node.is_dynamic_element
					? x`@set_dynamic_element_data(${this.node.tag_expr.manipulate(block)})`
					: x`@set_attributes`;

		block.chunks.hydrate.push(
			b`${fn}(${this.var}, {${static_attributes}});`
		);
	}

	add_transitions(block: Block) {
		const { intro, outro } = this.node;
		if (!intro && !outro) return;

		if (intro === outro) {
			// bidirectional transition
			const name = block.get_unique_name(`${this.var.name}_transition`);
			const snippet = intro.expression
				? intro.expression.manipulate(block)
				: x`{}`;

			block.add_variable(name);

			const fn = this.renderer.reference(intro.name);

			const intro_block = b`
				@add_render_callback(() => {
					if (!#current) return;
					if (!${name}) ${name} = @create_bidirectional_transition(${this.var}, ${fn}, ${snippet}, true);
					${name}.run(1);
				});
			`;

			const outro_block = b`
				if (!${name}) ${name} = @create_bidirectional_transition(${this.var}, ${fn}, ${snippet}, false);
				${name}.run(0);
			`;

			if (intro.is_local) {
				block.chunks.intro.push(b`
					if (#local) {
						${intro_block}
					}
				`);

				block.chunks.outro.push(b`
					if (#local) {
						${outro_block}
					}
				`);
			} else {
				block.chunks.intro.push(intro_block);
				block.chunks.outro.push(outro_block);
			}

			block.chunks.destroy.push(b`if (detaching && ${name}) ${name}.end();`);
		} else {
			const intro_name = intro && block.get_unique_name(`${this.var.name}_intro`);
			const outro_name = outro && block.get_unique_name(`${this.var.name}_outro`);

			if (intro) {
				block.add_variable(intro_name);
				const snippet = intro.expression
					? intro.expression.manipulate(block)
					: x`{}`;

				const fn = this.renderer.reference(intro.name);

				let intro_block: Node[];

				if (outro) {
					intro_block = b`
						@add_render_callback(() => {
							if (!#current) return;
							if (${outro_name}) ${outro_name}.end(1);
							${intro_name} = @create_in_transition(${this.var}, ${fn}, ${snippet});
							${intro_name}.start();
						});
					`;

					block.chunks.outro.push(b`if (${intro_name}) ${intro_name}.invalidate();`);
				} else {
					intro_block = b`
						if (!${intro_name}) {
							@add_render_callback(() => {
								${intro_name} = @create_in_transition(${this.var}, ${fn}, ${snippet});
								${intro_name}.start();
							});
						}
					`;
				}

				if (intro.is_local) {
					intro_block = b`
						if (#local) {
							${intro_block}
						}
					`;
				}

				block.chunks.intro.push(intro_block);
			}

			if (outro) {
				block.add_variable(outro_name);
				const snippet = outro.expression
					? outro.expression.manipulate(block)
					: x`{}`;

				const fn = this.renderer.reference(outro.name);

				if (!intro) {
					block.chunks.intro.push(b`
						if (${outro_name}) ${outro_name}.end(1);
					`);
				}

				// TODO hide elements that have outro'd (unless they belong to a still-outroing
				// group) prior to their removal from the DOM
				let outro_block = b`
					${outro_name} = @create_out_transition(${this.var}, ${fn}, ${snippet});
				`;

				if (outro.is_local) {
					outro_block = b`
						if (#local) {
							${outro_block}
						}
					`;
				}

				block.chunks.outro.push(outro_block);

				block.chunks.destroy.push(b`if (detaching && ${outro_name}) ${outro_name}.end();`);
			}
		}

		if ((intro && intro.expression && intro.expression.dependencies.size) || (outro && outro.expression && outro.expression.dependencies.size)) {
			block.maintain_context = true;
		}
	}

	add_animation(block: Block) {
		if (!this.node.animation) return;

		const { outro } = this.node;

		const rect = block.get_unique_name('rect');
		const stop_animation = block.get_unique_name('stop_animation');

		block.add_variable(rect);
		block.add_variable(stop_animation, x`@noop`);

		block.chunks.measure.push(b`
			${rect} = ${this.var}.getBoundingClientRect();
		`);

		if (block.type === CHILD_DYNAMIC_ELEMENT_BLOCK) {
			block.chunks.measure.push(b`return ${rect}`);
			block.chunks.restore_measurements.push(b`${rect} = #measurement;`);
		}

		block.chunks.fix.push(b`
			@fix_position(${this.var});
			${stop_animation}();
			${outro && b`@add_transform(${this.var}, ${rect});`}
		`);

		let params: Node | ReturnType<typeof x>;
		if (this.node.animation.expression) {
			params = this.node.animation.expression.manipulate(block);

			if (this.node.animation.expression.dynamic_dependencies().length) {
				// if `params` is dynamic, calculate params ahead of time in the `.r()` method
				const params_var = block.get_unique_name('params');
				block.add_variable(params_var);

				block.chunks.measure.push(b`${params_var} = ${params};`);
				params = params_var;
			}
		} else {
			params = x`{}`;
		}

		const name = this.renderer.reference(this.node.animation.name);

		block.chunks.animate.push(b`
			${stop_animation}();
			${stop_animation} = @create_animation(${this.var}, ${rect}, ${name}, ${params});
		`);
	}

	add_classes(block: Block) {
		const has_spread = this.node.attributes.some(attr => attr.is_spread);
		this.node.classes.forEach(class_directive => {
			const { expression, name } = class_directive;
			let snippet: Node | string;
			let dependencies: Set<string>;
			if (expression) {
				snippet = expression.manipulate(block);
				dependencies = expression.dependencies;
			} else {
				snippet = name;
				dependencies = new Set([name]);
			}
			const updater = b`@toggle_class(${this.var}, "${name}", ${snippet});`;

			block.chunks.hydrate.push(updater);

			if ((this.node.is_dynamic_element || has_spread) && this.has_dynamic_attribute) {
				block.chunks.update.push(updater);
			} else if ((dependencies && dependencies.size > 0) || this.class_dependencies.length) {
				const all_dependencies = this.class_dependencies.concat(...dependencies);
				let condition = block.renderer.dirty(all_dependencies);
				if (block.has_outros) {
					condition = x`!#current || ${condition}`;
				}

				// If all of the dependencies are non-dynamic (don't get updated) then there is no reason
				// to add an updater for this.
				const any_dynamic_dependencies = all_dependencies.some((dep) => {
					const variable = this.renderer.component.var_lookup.get(dep);
					return !variable || is_dynamic(variable);
				});
				if (any_dynamic_dependencies) {
					block.chunks.update.push(b`
						if (${condition}) {
							${updater}
						}
					`);
				}
			}
		});
	}

	add_styles(block: Block) {
		const has_spread = this.node.attributes.some(attr => attr.is_spread);

		let style_changed_var: Identifier | undefined;
		const maybe_create_style_changed_var = () => {
			if (!style_changed_var && this.dynamic_style_dependencies.size) {
				style_changed_var = block.get_unique_name('style_changed');
				const style_attr_dirty =  block.renderer.dirty([...this.dynamic_style_dependencies]);
				block.chunks.update.push(b`const ${style_changed_var} = ${style_attr_dirty};`);
			}
		};

		this.node.styles.forEach((style_directive) => {
			const { name, expression, important, should_cache } = style_directive;

			const snippet = expression.manipulate(block);
			let cached_snippet: Identifier | undefined;
			if (should_cache) {
				cached_snippet = block.get_unique_name(`style_${name.replace(regex_minus_signs, '_')}`);
				block.add_variable(cached_snippet, snippet);
			}

			const updater = b`@set_style(${this.var}, "${name}", ${should_cache ? cached_snippet : snippet}, ${important ? 1 : null})`;

			block.chunks.hydrate.push(updater);

			// Assume that style has changed through the spread attribute
			if (has_spread) {
				block.chunks.update.push(updater);
			} else {
				const self_deps = expression.dynamic_dependencies();
				const all_deps = new Set([
					...self_deps,
					...this.dynamic_style_dependencies
				]);

				if (all_deps.size === 0) return;

				let condition =  block.renderer.dirty([...all_deps]);

				if (should_cache) {
					condition = x`${condition} && ${cached_snippet} !== (${cached_snippet} = ${snippet})`;
				}

				if (this.dynamic_style_dependencies.size > 0) {
					maybe_create_style_changed_var();
					// If all dependencies are same as the style attribute dependencies, then we can skip the dirty check
					condition =
						all_deps.size === this.dynamic_style_dependencies.size
							? style_changed_var
							: x`${style_changed_var} || ${condition}`;
				}

				block.chunks.update.push(b`
					if (${condition}) {
						${updater}
					}
				`);
			}
		});
	}

	add_manual_style_scoping(block: Block) {
		if (this.node.needs_manual_style_scoping) {
			const updater = b`@toggle_class(${this.var}, "${this.node.component.stylesheet.id}", true);`;
			block.chunks.hydrate.push(updater);
			block.chunks.update.push(updater);
		}
	}
}

const regex_backticks = /`/g;
const regex_dollar_signs = /\$/g;

function to_html(wrappers: Array<ElementWrapper | TextWrapper | MustacheTagWrapper | RawMustacheTagWrapper>, block: Block, literal: any, state: any, can_use_raw_text?: boolean) {
	wrappers.forEach(wrapper => {
		if (wrapper instanceof TextWrapper) {
			// Don't add the <pre>/<textarea> newline logic here because pre/textarea.innerHTML
			// would keep the leading newline, too, only someParent.innerHTML = '..<pre/textarea>..' won't

			if ((wrapper as TextWrapper).use_space()) state.quasi.value.raw += ' ';

			const parent = wrapper.node.parent as Element;

			const raw = parent && (
				parent.name === 'script' ||
				parent.name === 'style' ||
				can_use_raw_text
			);

			state.quasi.value.raw += (raw ? wrapper.data : escape_html(wrapper.data))
				.replace(regex_backslashes, '\\\\')
				.replace(regex_backticks, '\\`')
				.replace(regex_dollar_signs, '\\$');
		} else if (wrapper instanceof MustacheTagWrapper || wrapper instanceof RawMustacheTagWrapper) {
			literal.quasis.push(state.quasi);
			literal.expressions.push(wrapper.node.expression.manipulate(block));
			state.quasi = {
				type: 'TemplateElement',
				value: { raw: '' }
			};
		} else if (wrapper.node.name === 'noscript') {
			// do nothing
		} else {
			const nodeName = wrapper.node.name;

			// element
			state.quasi.value.raw += `<${nodeName}`;

			const is_empty_textarea = nodeName === 'textarea' && wrapper.fragment.nodes.length === 0;

			(wrapper as ElementWrapper).attributes.forEach((attr: AttributeWrapper) => {
				if (is_empty_textarea && attr.node.name === 'value') {
					// The value attribute of <textarea> renders as content.
					return;
				}
				state.quasi.value.raw += ` ${fix_attribute_casing(attr.node.name)}="`;

				to_html_for_attr_value(attr, block, literal, state);

				state.quasi.value.raw += '"';
			});

			if (!wrapper.void) {
				state.quasi.value.raw += '>';

				if (nodeName === 'pre') {
					// Two or more leading newlines are required to restore the leading newline immediately after `<pre>`.
					// see https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
					const first = wrapper.fragment.nodes[0];
					if (first && first.node.type === 'Text' && regex_starts_with_newline.test(first.node.data)) {
						state.quasi.value.raw += '\n';
					}
				}

				if (is_empty_textarea) {
					// The <textarea> renders the value attribute as content because the content is stored in the value attribute.
					const value_attribute = wrapper.attributes.find(attr => attr.node.name === 'value');
					if (value_attribute) {
						// Two or more leading newlines are required to restore the leading newline immediately after `<textarea>`.
						// see https://html.spec.whatwg.org/multipage/syntax.html#element-restrictions
						const first = value_attribute.node.chunks[0];
						if (first && first.type === 'Text' && regex_starts_with_newline.test(first.data)) {
							state.quasi.value.raw += '\n';
						}
						to_html_for_attr_value(value_attribute, block, literal, state);
					}
				}

				to_html(wrapper.fragment.nodes as Array<ElementWrapper | TextWrapper>, block, literal, state);

				state.quasi.value.raw += `</${nodeName}>`;
			} else {
				state.quasi.value.raw += '/>';
			}
		}
	});
}

function to_html_for_attr_value(attr: AttributeWrapper | StyleAttributeWrapper | SpreadAttributeWrapper, block: Block, literal: any, state: any) {
	attr.node.chunks.forEach(chunk => {
		if (chunk.type === 'Text') {
			state.quasi.value.raw += escape_html(chunk.data);
		} else {
			literal.quasis.push(state.quasi);
			literal.expressions.push(chunk.manipulate(block));

			state.quasi = {
				type: 'TemplateElement',
				value: { raw: '' }
			};
		}
	});
}
