#include <cstring>

#include <gv/algorithms.hpp>

namespace
{
	std::optional<gv::Document> clipboard;

	json web_execute(const json& request)
	{
		const std::string op = request.at("op");
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
			const std::string action = request.at("action");
			if (action == "select_all")
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
				session.beginEdit();
				try
				{
					if (action == "settings")
					{
						if (request.contains("defaults"))
							session.setDefaults(request.at("defaults").get<gv::Defaults>());

						if (request.contains("canvas"))
							session.setCanvasStyle(request.at("canvas").get<gv::CanvasStyle>());
					}
					else if (action == "theme")
					{
						const gv::ThemeProfile theme = gv::parse_theme_profile(request.at("text").get<std::string>());
						session.setDefaults(theme.defaults);
						session.setCanvasStyle(theme.canvas);
					}
					else if (action == "fonts")
					{
						gv::FontSettings fonts = before.fonts;
						const int policy = request.at("missing");
						if (policy < 0 or 2 < policy)
							throw fault("invalid_input", "Invalid font policy");

						fonts.embed = request.at("embed");
						fonts.missing = static_cast<gv::MissingFontPolicy>(policy);
						fonts.fallbackFamily = request.at("fallbackFamily");
						session.setFontSettings(std::move(fonts));
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
					session.endEdit();
				}
				catch (...)
				{
					session.cancelEdit();
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
		if (request == nullptr or std::strlen(request) > 1'048'576)
			throw fault("size_limit", "Request exceeds 1 MiB");

		response = web_execute(json::parse(request)).dump();
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
