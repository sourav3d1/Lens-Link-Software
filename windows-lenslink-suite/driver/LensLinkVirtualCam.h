#pragma once

#include <windows.h>
#include <streams.h>
#include <initguid.h>
#include <olectl.h>
#include <ks.h>
#include <ksmedia.h>
#include <cstdint>

// {8E4F1C3A-7B9D-4A2E-9F14-6C5B2D8E3A10}
DEFINE_GUID(CLSID_LensLinkWirelessWebcam,
    0x8e4f1c3a, 0x7b9d, 0x4a2e, 0x9f, 0x14, 0x6c, 0x5b, 0x2d, 0x8e, 0x3a, 0x10);

#define LENSLINK_DEVICE_NAME       L"LensLink Wireless Webcam"
#define LENSLINK_SHMEM_NAME        L"Local\\LensLinkWirelessWebcamFrameBuffer"
#define LENSLINK_MUTEX_NAME        L"Local\\LensLinkWirelessWebcamMutex"

#define LENSLINK_MAX_WIDTH         3840
#define LENSLINK_MAX_HEIGHT        2160
#define LENSLINK_MAX_FRAME_BYTES   (LENSLINK_MAX_WIDTH * LENSLINK_MAX_HEIGHT * 3) // RGB24 up to 4K

#pragma pack(push, 1)
struct LensLinkSharedFrameHeader {
    uint32_t magic;          // 'LNSL' = 0x4C534E4C
    uint32_t version;        // 1
    uint32_t width;          // Active frame width (e.g. 1920)
    uint32_t height;         // Active frame height (e.g. 1080)
    uint32_t fps;            // Target FPS (24, 30, 60)
    uint32_t pixelFormat;    // 1 = RGB24 (top-down from client, flipped for DirectShow DIB)
    uint64_t frameSeq;       // Monotonic frame sequence counter
    uint64_t timestampUs;    // Capture timestamp in microseconds
    uint32_t phoneConnected; // 1 = live smartphone feed active, 0 = standby card
    uint32_t reserved[3];
};
#pragma pack(pop)

constexpr uint32_t LENSLINK_SHMEM_MAGIC = 0x4C534E4C;
constexpr size_t LENSLINK_SHMEM_TOTAL_BYTES = sizeof(LensLinkSharedFrameHeader) + LENSLINK_MAX_FRAME_BYTES;

class CLensLinkVirtualCamPin : public CSourceStream, public IAMStreamConfig, public IKsPropertySet {
public:
    CLensLinkVirtualCamPin(HRESULT* phr, CSource* pParent, LPCWSTR pPinName);
    ~CLensLinkVirtualCamPin() override;

    DECLARE_IUNKNOWN;
    STDMETHODIMP NonDelegatingQueryInterface(REFIID riid, void** ppv) override;

    // CSourceStream overrides
    HRESULT FillBuffer(IMediaSample* pms) override;
    HRESULT DecideBufferSize(IMemAllocator* pAlloc, ALLOCATOR_PROPERTIES* pRequest) override;
    HRESULT CheckMediaType(const CMediaType* pMediaType) override;
    HRESULT GetMediaType(int iPosition, CMediaType* pMediaType) override;
    HRESULT SetMediaType(const CMediaType* pMediaType) override;
    HRESULT OnThreadCreate() override;

    // IAMStreamConfig
    STDMETHODIMP SetFormat(AM_MEDIA_TYPE* pmt) override;
    STDMETHODIMP GetFormat(AM_MEDIA_TYPE** ppmt) override;
    STDMETHODIMP GetNumberOfCapabilities(int* piCount, int* piSize) override;
    STDMETHODIMP GetStreamCaps(int iIndex, AM_MEDIA_TYPE** pmt, BYTE* pSCC) override;

    // IKsPropertySet (exposes PIN_CATEGORY_CAPTURE to Chrome, Edge, Meet, Zoom, Teams, OBS)
    STDMETHODIMP Set(REFGUID guidPropSet, DWORD dwID, void* pInstanceData, DWORD cbInstanceData,
                     void* pPropData, DWORD cbPropData) override;
    STDMETHODIMP Get(REFGUID guidPropSet, DWORD dwID, void* pInstanceData, DWORD cbInstanceData,
                     void* pPropData, DWORD cbPropData, DWORD* pcbReturned) override;
    STDMETHODIMP QuerySupported(REFGUID guidPropSet, DWORD dwID, DWORD* pTypeSupport) override;

private:
    void OpenSharedMemory();
    void CloseSharedMemory();
    void RenderStandbyFrame(BYTE* dst, int width, int height);

    int m_width = 1280;
    int m_height = 720;
    int m_fps = 30;
    REFERENCE_TIME m_rtFrameLength = 333333; // 30 fps in 100ns units
    REFERENCE_TIME m_rtLastTime = 0;

    HANDLE m_hMapFile = nullptr;
    HANDLE m_hMutex = nullptr;
    BYTE* m_pSharedBuf = nullptr;
};

class CLensLinkVirtualCam : public CSource {
public:
    static CUnknown* WINAPI CreateInstance(LPUNKNOWN lpunk, HRESULT* phr);
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override;

private:
    CLensLinkVirtualCam(LPUNKNOWN lpunk, HRESULT* phr);
};
