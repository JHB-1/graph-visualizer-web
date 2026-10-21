#include <cstring>
#include <set>

#include <gv/algorithms.hpp>

namespace
{
	std::optional<gv::Document> clipboard;
	std::map<std::string, std::string> live_styles;

	gv::Document read_document(const json& file)
	{
		if (file.at("format") != "graph-visualizer" or file.at("version") != 1)
			throw fault("invalid_input", "지원하지 않는 그래프 파일 형식/버전입니다");

		const json& input = file.at("document");
		for (const auto& [key, ignored] : input.items())
			if (key != "nodes" and key != "edges" and key != "defaults" and key != "options" and key != "canvas" and key != "fonts")
				throw fault("invalid_input", "Unknown document field: " + key);

		gv::Document document;
		document.nodes = input.at("nodes").get<std::vector<gv::Node>>();
		document.edges = input.at("edges").get<std::vector<gv::Edge>>();
		document.defaults = input.at("defaults").get<gv::Defaults>();
		document.options = input.at("options").get<gv::Options>();
		document.canvas = input.at("canvas").get<gv::CanvasStyle>();
		for (const json& node : input.at("nodes"))
			for (const std::string key : { "id", "label", "center", "size", "parent", "subgraph", "expanded", "style" })
				if (not node.contains(key))
					throw fault("invalid_input", "Missing node field: " + key);

		for (const json& edge : input.at("edges"))
			for (const std::string key : { "id", "source", "target", "direction", "style" })
				if (not edge.contains(key))
					throw fault("invalid_input", "Missing edge field: " + key);

		const json& fonts = input.at("fonts");
		document.fonts.embed = fonts.at("embed").get<bool>();
		const int missing = fonts.at("missing").get<int>();
		if (missing < 0 or 2 < missing)
			throw fault("invalid_input", "Invalid font policy");

		document.fonts.missing = static_cast<gv::MissingFontPolicy>(missing);
		document.fonts.fallbackFamily = fonts.at("fallbackFamily").get<std::string>();
		for (const json& input_asset : fonts.at("assets"))
		{
			gv::FontAsset asset;
			asset.family = input_asset.at("family").get<std::string>();
			asset.style = input_asset.at("style").get<std::string>();
			const std::string hex = input_asset.at("data").get<std::string>();
			std::vector<std::uint8_t> bytes;
			if (hex.size() % 2 != 0)
				throw fault("invalid_input", "Invalid embedded font data");

			for (std::size_t index = 0; index < hex.size(); index += 2)
			{
				unsigned int value = 0;
				const auto [end, error] = std::from_chars(hex.data() + index, hex.data() + index + 2, value, 16);
				if (error != std::errc() or end != hex.data() + index + 2)
					throw fault("invalid_input", "Invalid embedded font data");

				bytes.push_back(static_cast<std::uint8_t>(value));
			}

			asset.data = gv::FontData(std::move(bytes));
			document.fonts.assets.push_back(std::move(asset));
		}

		gv::validate(document);

		return document;
	}

	void finish_style(const std::string& graph_id)
	{
		if (live_styles.erase(graph_id) == 0)
			return;

		const auto found = graphs.find(graph_id);
		if (found != graphs.end())
			found->second->graph.session().endEdit();
	}

	json web_execute(const json& request)
	{
		const std::string op = request.at("op");
		const std::string graph_id = request.value("graph_id", "");
		const std::string action = request.value("action", "");
		const bool live = op == "web_edit" and request.contains("edit_key") and action != "end_style";
		const bool reading = op == "web_read" or op == "status" or op == "query" or op == "snapshot" or
			op == "web_checkpoint" or op == "web_validate" or op == "web_endpoints";
		const bool feedback = op == "ui" and (action == "hover" or action == "active");
		if (not live and not reading and not feedback and action != "end_style")
			finish_style(graph_id);

		if (op == "web_checkpoint")
			return execute({ { "op", "export" }, { "graph_id", graph_id } });

		if (op == "web_validate")
		{
			read_document(request.at("file"));

			return { { "result", { { "valid", true } } } };
		}
		if (op == "web_endpoints")
		{
			const auto found = graphs.find(graph_id);
			if (found == graphs.end())
				throw fault("closed_graph", "Graph does not exist");

			check_idle(*found->second);
			check_revision(request, *found->second);
			if (request.at("ids").size() > 2)
				throw fault("size_limit", "At most two endpoint representatives");

			json candidates = json::object();
			for (const json& id : request.at("ids"))
				candidates[id.get<std::string>()] = id_json(found->second->graph.session().endpointCandidates(parse_id(id)));

			return { { "result", { { "candidates", candidates } } } };
		}

		if (op == "web_open")
		{
			const auto found = graphs.find(graph_id);
			if (found == graphs.end())
				throw fault("closed_graph", "Graph does not exist");

			check_idle(*found->second);
			check_revision(request, *found->second);
			const gv::Document document = read_document(request.at("file"));
			auto replacement = std::make_unique<graph_state>(document);
			replacement->document_revision = found->second->document_revision + 1;
			replacement->focus_event = found->second->focus_event;
			gv::scene_delta delta = replacement->graph.scene_changes();
			const gv::Scene previous = found->second->graph.session().scene();
			for (const gv::NodeVisual& node : previous.frames)
				delta.removed_frames.push_back(node.node.id);

			for (const gv::NodeVisual& node : previous.nodes)
				delta.removed_nodes.push_back(node.node.id);

			for (const gv::EdgeVisual& edge : previous.edges)
				delta.removed_edges.push_back(edge.id);

			replacement->render_revision = delta.revision;
			json result = versions(*replacement);
			result["replaced"] = true;
			json response = { { "result", result }, { "delta", delta } };

			// 검증/새 세션 준비 후 원본 교체, 입력 오류 시 기존 문서 보존
			found->second.swap(replacement);
			clipboard.reset();

			return response;
		}

		if (op != "web_read" and op != "web_edit")
			return execute(request);

		const auto found = graphs.find(request.at("graph_id").get<std::string>());
		if (found == graphs.end())
			throw fault("closed_graph", "Graph does not exist");

		graph_state& state = *found->second;
		gv::GraphSession& session = state.graph.session();
		check_idle(state);
		json extra = json::object();
		if (op == "web_edit")
		{
			check_revision(request, state);
			if (action == "end_style")
			{
				const auto pending = live_styles.find(graph_id);
				if (pending != live_styles.end() and pending->second == request.at("edit_key").get<std::string>())
					finish_style(graph_id);
			}
			else if (action == "select_all")
			{
				session.clearSelection();
				for (const gv::NodeVisual& node : session.scene().nodes)
					session.toggleNodeSelection(node.node.id);
			}
			else if (action == "clear_selection")
				session.clearSelection();
			else if (action == "select_region")
				session.selectRegion(request.at("region").get<gv::Rect>(), request.value("additive", false));
			else if (action == "copy")
				clipboard = session.copySelection();
			else if (action == "history_limit")
				session.setUndoLimit(request.at("limit").get<std::size_t>());
			else if (action == "algorithm")
			{
				const int kind = request.at("kind");
				if (kind < 0 or 4 < kind)
					throw fault("invalid_input", "Invalid algorithm");

				std::optional<gv::NodeId> start;
				std::optional<gv::NodeId> target;
				read_id(request.at("start"), start);
				read_id(request.at("target"), target);
				const gv::AlgorithmResult result = session.runAlgorithm(static_cast<gv::AlgorithmKind>(kind), start, target);
				json steps = json::array();
				for (const gv::AlgorithmStep& step : result.steps)
					steps.push_back({ { "nodes", id_json(step.nodes) }, { "edges", id_json(step.edges) }, { "text", step.description } });

				extra["algorithm"] = json
				{
					{ "summary", result.summary }, { "steps", steps }, { "found", result.found },
					{ "negativeCycle", result.negativeCycle }, { "weight", result.totalWeight }
				};
			}
			else if (action == "algorithm_step")
				session.setAlgorithmStep(request.at("step").get<std::size_t>());
			else if (action == "algorithm_clear")
				session.clearAlgorithm();
			else
			{
				const gv::Document before = session.document();
				gv::Document candidate = before;
				const bool style_action = action == "settings" or action == "fonts" or action == "selection_style" or action == "theme";
				if (live and not style_action)
					throw fault("invalid_input", "Only style edits can be grouped");

				if (action == "settings")
				{
					if (request.contains("defaults"))
						candidate.defaults = request.at("defaults").get<gv::Defaults>();

					if (request.contains("canvas"))
						candidate.canvas = request.at("canvas").get<gv::CanvasStyle>();
				}
				else if (action == "fonts")
				{
					const int policy = request.at("missing");
					if (policy < 0 or 2 < policy)
						throw fault("invalid_input", "Invalid font policy");

					candidate.fonts.embed = request.at("embed");
					candidate.fonts.missing = static_cast<gv::MissingFontPolicy>(policy);
					candidate.fonts.fallbackFamily = request.at("fallbackFamily");
				}
				else if (action == "theme")
				{
					const gv::ThemeProfile theme = gv::parse_theme_profile(request.at("text").get<std::string>());
					candidate.defaults = theme.defaults;
					candidate.canvas = theme.canvas;
				}
				else if (action == "selection_style")
				{
					const std::uint64_t id = parse_id(request.at("id"));
					bool found_item = false;
					if (request.at("kind") == "node")
					{
						for (gv::Node& node : candidate.nodes)
							if (node.id == id)
							{
								node.style = request.at("style").get<gv::NodeStyleOverrides>();
								node.shape = request.at("shape").get<std::optional<gv::NodeShape>>();
								node.profile = request.at("profile").get<std::optional<std::string>>();
								found_item = true;
							}
					}
					else if (request.at("kind") == "edge")
					{
						for (gv::Edge& edge : candidate.edges)
							if (edge.id == id)
							{
								edge.style = request.at("style").get<gv::EdgeStyleOverrides>();
								edge.routing = request.at("routing").get<std::optional<gv::RoutingMode>>();
								edge.profile = request.at("profile").get<std::optional<std::string>>();
								found_item = true;
							}
					}

					if (not found_item)
						throw fault("missing_id", "Style target does not exist");
				}

				// 입력 오류는 진행 중인 편집의 마지막 유효 값을 보존
				if (style_action)
					gv::validate(candidate);

				if (live)
				{
					const std::string key = request.at("edit_key");
					const auto pending = live_styles.find(graph_id);
					if (pending != live_styles.end() and pending->second != key)
						finish_style(graph_id);

					if (not live_styles.contains(graph_id))
					{
						live_styles.emplace(graph_id, key);
						try
						{
							session.beginEdit();
						}
						catch (...)
						{
							live_styles.erase(graph_id);
							throw;
						}
					}
				}
				else
					session.beginEdit();

				try
				{
					if (action == "settings")
					{
						session.setDefaults(candidate.defaults);
						session.setCanvasStyle(candidate.canvas);
					}
					else if (action == "theme")
					{
						session.setDefaults(candidate.defaults);
						session.setCanvasStyle(candidate.canvas);
					}
					else if (action == "fonts")
						session.setFontSettings(candidate.fonts);
					else if (action == "selection_style")
					{
						const std::uint64_t id = parse_id(request.at("id"));
						if (request.at("kind") == "node")
						{
							for (const gv::Node& node : candidate.nodes)
								if (node.id == id)
								{
									session.setNodeProfile(id, node.profile);
									session.setNodeShape(id, node.shape);
									session.setNodeStyle(id, node.style);
								}
						}
						else
							for (const gv::Edge& edge : candidate.edges)
								if (edge.id == id)
								{
									session.setEdgeProfile(id, edge.profile);
									session.setEdgeRouting(id, edge.routing);
									session.setEdgeStyle(id, edge.style);
								}
					}
					else if (action == "delete")
						session.deleteSelection();
					else if (action == "duplicate")
						session.duplicateSelection();
					else if (action == "paste")
					{
						if (not clipboard)
							throw fault("invalid_input", "Clipboard is empty");

						session.paste(*clipboard);
					}
					else if (action == "group")
						session.groupSelection(request.value("label", "그룹"));
					else if (action == "ungroup")
						session.ungroup(parse_id(request.at("id")));
					else if (action == "connect")
					{
						const int direction = request.value("direction", 1);
						if (direction != 0 and direction != 1)
							throw fault("invalid_input", "Invalid direction");

						const gv::EdgeId id = session.addEdge
						(
							parse_id(request.at("source")), parse_id(request.at("target")), static_cast<gv::EdgeDirection>(direction)
						);
						session.setEdgeLabel(id, request.value("label", ""));
					}
					else if (action == "add")
						session.addNode(request.at("point").get<gv::Point>(), request.value("label", "노드"));
					else if (action == "reverse")
						session.reverseEdge(parse_id(request.at("id")));
					else if (action == "nudge")
					{
						const gv::Point offset = request.at("offset").get<gv::Point>();
						std::set<gv::NodeId> selected_nodes;
						for (const gv::NodeId id : session.selectedNodes())
							selected_nodes.insert(id);

						for (const gv::Node& node : before.nodes)
						{
							if (not selected_nodes.contains(node.id))
								continue;

							std::optional<gv::NodeId> parent = node.parent;
							bool nested = false;
							while (parent)
							{
								if (selected_nodes.contains(*parent)) { nested = true; break; }

								const auto found_parent = std::find_if
								(
									before.nodes.begin(), before.nodes.end(),
									[parent](const gv::Node& item) -> bool { return item.id == parent; }
								);
								parent = found_parent == before.nodes.end() ? std::nullopt : found_parent->parent;
							}

							if (not nested)
								session.moveNode(node.id, { node.center.x + offset.x, node.center.y + offset.y });
						}
					}
					else if (action == "label_position")
						session.setEdgeLabelPosition(parse_id(request.at("id")), request.at("point").get<gv::Point>());
					else if (action == "waypoints")
						session.setEdgeWaypoints(parse_id(request.at("id")), request.at("points").get<std::vector<gv::Point>>());
					else if (action == "reconnect")
						session.reconnectEdge
						(
							parse_id(request.at("id")), parse_id(request.at("source")), parse_id(request.at("target"))
						);
					else if (action == "reset_style")
					{
						if (request.at("kind") == "node")
							session.resetNodeStyle(parse_id(request.at("id")));
						else
							session.resetEdgeStyle(parse_id(request.at("id")));
					}
					else
						throw fault("invalid_input", "Unknown web command");

					// 여러 설정을 문서 이력 한 건으로 반영
					if (not live)
						session.endEdit();
				}
				catch (...)
				{
					session.cancelEdit();
					live_styles.erase(graph_id);
					if (session.document() != before)
						increment(state);

					throw;
				}

				if (session.document() != before)
					increment(state);
			}
		}

		const gv::Document document = session.document();
		extra["defaults"] = document.defaults;
		extra["canvas"] = document.canvas;
		extra["options"] = document.options;
		extra["nodes"] = document.nodes;
		extra["edges"] = document.edges;
		extra["selected_nodes"] = id_json(session.selectedNodes());
		extra["selected_edges"] = id_json(session.selectedEdges());
		extra["undo_limit"] = session.undoLimit();
		extra["undo_count"] = session.undoCount();
		extra["fonts"] = json
		{
			{ "embed", document.fonts.embed }, { "missing", document.fonts.missing },
			{ "fallbackFamily", document.fonts.fallbackFamily }
		};
		extra["scope"] = id_json(session.scope());
		extra["theme_text"] = gv::serialize_theme_profile(gv::theme_profile_from_document(document));
		json response = execute({ { "op", "status" }, { "graph_id", request.at("graph_id") } });
		response["result"]["web"] = extra;

		return response;
	}
}

// 요청 직렬 처리, 반환 문자열은 다음 호출 전까지 유효
extern "C" const char* gv_request(const char* request)
{
	static std::string response;
	try
	{
		if (request == nullptr or std::strlen(request) > 1'049'600)
			throw fault("size_limit", "Request exceeds 1 MiB");

		const json parsed = json::parse(request);
		const bool file_request = parsed.value("op", "") == "web_open" or parsed.value("op", "") == "web_validate";
		if (std::strlen(request) > 1'048'576 and not file_request)
			throw fault("size_limit", "Request exceeds 1 MiB");

		if (file_request and parsed.at("file").dump().size() > 1'048'576)
			throw fault("size_limit", "Graph file exceeds 1 MiB");

		response = web_execute(parsed).dump();
	}
	catch (const fault& error)
	{
		response = json({ { "error", { { "code", error.code }, { "message", error.what() } } } }).dump();
	}
	catch (const std::exception& error)
	{
		response = json({ { "error", { { "code", "invalid_input" }, { "message", error.what() } } } }).dump();
	}

	return response.c_str();
}
