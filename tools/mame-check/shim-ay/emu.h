// MAME の ay8910.cpp をそのまま動かすための最小の枠（T-110）。計算の部分には手を入れない
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using s8 = std::int8_t;
using s16 = std::int16_t;
using s32 = std::int32_t;
using offs_t = u32;

#define ATTR_COLD
#define BIT(x, n) (((x) >> (n)) & 1)
#define NAME(x) x
#define STRUCT_MEMBER(s, m) s

using device_type = const void *;
#define DECLARE_DEVICE_TYPE(Type, Class) extern const device_type Type;
#define DEFINE_DEVICE_TYPE(Type, Class, Short, Full) static const char Type##_id = 0; const device_type Type = &Type##_id;

[[noreturn]] inline void fatalerror(const char *fmt, ...) { std::fprintf(stderr, "fatal: %s\n", fmt); std::abort(); }

template <typename T> std::unique_ptr<T> make_unique_clear(std::size_t n) {
	using E = typename std::remove_extent<T>::type;
	return std::unique_ptr<T>(new E[n]());
}

struct machine_config {};
struct running_machine { const char *describe_context() const { return ""; } };

class sound_stream {
public:
	using sample_t = float;
	explicit sound_stream(u32 rate) : m_rate(rate) {}
	int samples() const { return int(m_out.size()); }
	void put(int, int i, sample_t v) { m_out[i] = v; }
	void update() {}
	void set_sample_rate(u32 rate) { m_rate = rate; }
	void begin(int n) { m_out.assign(n, 0.0f); }
	const std::vector<sample_t> &out() const { return m_out; }
	u32 rate() const { return m_rate; }
private:
	u32 m_rate;
	std::vector<sample_t> m_out;
};

class device_t {
public:
	device_t(const machine_config &, device_type type, const char *, device_t *, u32 clock) : m_type(type), m_clock(clock) {}
	virtual ~device_t() = default;
	u32 clock() const { return m_clock; }
	device_type type() const { return m_type; }
	const char *name() const { return "psg"; }
	const char *tag() const { return ":psg"; }
	running_machine &machine() { return m_machine; }
	template <typename T> void save_item(T &&) {}
protected:
	virtual void device_start() {}
	virtual void device_reset() {}
	virtual void device_clock_changed() {}
private:
	device_type m_type;
	u32 m_clock;
	running_machine m_machine;
};

class device_sound_interface {
public:
	device_sound_interface(const machine_config &, device_t &) {}
	virtual ~device_sound_interface() = default;
	sound_stream *stream_alloc(int, int, u32 rate) {
		m_stream_owned = std::make_unique<sound_stream>(rate);
		return m_stream_owned.get();
	}
	sound_stream *owned_stream() { return m_stream_owned.get(); }
protected:
	virtual void sound_stream_update(sound_stream &stream) = 0;
private:
	std::unique_ptr<sound_stream> m_stream_owned;
};

// 入出力ポートの呼び出し（PSG のポート A・B）。照合では何もつながない
struct devcb_bind { template <typename... A> devcb_bind &set(A &&...) { return *this; } };
class devcb_read8 {
public:
	devcb_read8(device_t &, u8 def = 0xff) : m_def(def) {}
	devcb_bind bind() { return {}; }
	bool isunset() const { return true; }
	template <typename... A> u8 operator()(A &&...) { return m_def; }
private:
	u8 m_def;
};
class devcb_write8 {
public:
	devcb_write8(device_t &) {}
	devcb_bind bind() { return {}; }
	bool isunset() const { return true; }
	template <typename... A> void operator()(A &&...) {}
};
