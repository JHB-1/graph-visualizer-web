#include <cstring>

// 요청 직렬 처리, 반환 문자열은 다음 호출 전까지 유효
extern "C" const char* gv_request(const char* request)
{
	static std::string response;
	try
	{
		if (request == nullptr or std::strlen(request) > 1'048'576)
			throw fault("size_limit", "Request exceeds 1 MiB");

		response = execute(json::parse(request)).dump();
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
